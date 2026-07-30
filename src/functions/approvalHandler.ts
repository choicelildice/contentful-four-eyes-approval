/**
 * App Event handler (Contentful Function, invocation type `appevent.handler`).
 *
 * Enforcement model: a BLOCKING REVIEW TASK, created and OWNED by this app, that
 * only a non-contributor may clear.
 *
 * Contentful blocks publishing while an entry has any unresolved Task, so the
 * task itself is the hard, synchronous gate. This Function supplies the piece
 * Contentful can't: it ensures the person who *resolves* that review task is not
 * a contributor to the entry (the four-eyes rule).
 *
 * Two App Events drive it:
 *
 *   A. `ContentManagement.Workflow.save` — when an entry reaches the review step
 *      (`reviewStepId`), THIS APP creates the "Independent review required" task.
 *      The app must be the task's creator: Contentful only lets a task's creator
 *      (or an admin) re-open/edit it, so a workflow-created task cannot be re-opened
 *      by the app. An unresolved task blocks publishing.
 *
 *   B. `ContentManagement.Task.save` — when the review task is resolved, the app
 *      checks the resolver (event `sys.user`) against the entry's contributor set:
 *        - resolver is NOT a contributor -> leave resolved -> publish unblocked.
 *        - resolver IS a contributor (self-review) -> RE-OPEN the task (status
 *          back to `active`), reassign it to the resolver (native "assigned to you"
 *          notification), and rewrite the body to explain. Publishing stays blocked.
 *          The app owns the task (it created it in A), so this update is permitted.
 *
 * Why Tasks and not the Workflow step: an App Identity is NOT permitted to operate
 * on Workflow/WorkflowDefinition entities (a `PUT /workflows/{id}` returns 403,
 * actor `app-function`). `Task` IS in the app identity's allowed entity types, so
 * the app can create and update its OWN tasks — no service-account token needed.
 *
 * Known limitation (for compliance sign-off): App Events are asynchronous (seconds
 * of latency). The task-blocks-publish gate is synchronous and hard, but the
 * four-eyes check on *resolution* is eventual — there is a brief window in which a
 * contributor could self-resolve and publish before this handler re-opens the task.
 * Documented in the README; the synchronous gate is the task itself.
 */
import { collectContributors, evaluateFourEyes, type Snapshot } from './fourEyes.js';

/** Default body for the review task the app creates. `reviewTaskMarker` must be a
 *  substring of this so the Task.save path recognizes its own task. */
const DEFAULT_REVIEW_BODY =
  'Independent review required: a team member who did NOT edit this entry must ' +
  'review and resolve this task before it can be published (four-eyes policy).';
const DEFAULT_MARKER = 'Independent review required';

/** Minimal Task shape we rely on from the event payload / CMA. */
interface TaskLike {
  sys: {
    id: string;
    version: number;
    parentEntity?: { sys: { id: string; linkType: 'Entry' } };
  };
  body: string;
  status: 'active' | 'resolved';
  assignedTo?: { sys: { type: 'Link'; linkType: 'User' | 'Team'; id: string } };
}

interface UserLink {
  sys: { type: 'Link'; linkType: 'User' | 'AppDefinition'; id: string };
}

// Workflow.save event body (WorkflowProps subset).
interface WorkflowEventBody {
  stepId?: string;
  sys: { id: string; entity?: { sys: { id: string } }; updatedBy?: UserLink };
}

// Task.save event body (see SaveTaskEventPayload in the toolkit typings).
interface TaskEventBody {
  sys: {
    user?: { sys: { id: string } };
    oldTask?: TaskLike;
    newTask: TaskLike;
  };
}

interface FunctionEvent {
  headers: { 'X-Contentful-Topic'?: string } & Record<string, unknown>;
  body: any;
}

interface FunctionEventContext {
  spaceId: string;
  environmentId: string;
  appInstallationParameters: {
    /** Workflow step id ("In Review") at which the app creates the review task. */
    reviewStepId?: string;
    /** Optional substring the review task's body contains (defaults to DEFAULT_MARKER). */
    reviewTaskMarker?: string;
    /** Optional user id to assign the created review task to (notification hint). */
    reviewAssigneeId?: string;
  };
  // Pre-initialized CMA client authenticated as the App Identity.
  cma: any;
}

export interface HandlerResult {
  action: 'none' | 'created' | 'reopened';
  reason: string;
}

const markerOf = (ctx: FunctionEventContext) =>
  ctx.appInstallationParameters?.reviewTaskMarker?.trim() || DEFAULT_MARKER;

/**
 * A. Workflow reached the review step -> create the review task (idempotently).
 */
export async function handleWorkflowEvent(
  body: WorkflowEventBody,
  context: FunctionEventContext
): Promise<HandlerResult> {
  const reviewStepId = context.appInstallationParameters?.reviewStepId;
  if (!reviewStepId) {
    return { action: 'none', reason: 'No reviewStepId configured; task creation skipped.' };
  }
  if (body.stepId !== reviewStepId) {
    return { action: 'none', reason: 'Not the review step; no task to create.' };
  }
  const entryId = body.sys.entity?.sys.id;
  if (!entryId) {
    return { action: 'none', reason: 'Workflow has no linked entry; nothing to do.' };
  }

  const scope = { spaceId: context.spaceId, environmentId: context.environmentId };
  const cma = context.cma;

  // NOTE: we intentionally do NOT list existing tasks for idempotency here. The
  // app identity is denied `task.getMany` ("You are not allowed to query task",
  // 403), so querying would throw before we could create anything. Contentful's
  // Workflow.save fires once per step transition, so re-entering the review step
  // is the only way to create a duplicate; that is acceptable (it means a genuine
  // re-review) and is the correct behavior for this gate.

  // Assignee is a notification hint only (anyone on the team can resolve; the
  // four-eyes check catches whoever actually does). Prefer the configured
  // reviewer, else the person who moved the entry to review.
  const configured = context.appInstallationParameters?.reviewAssigneeId;
  const mover = body.sys.updatedBy?.sys.linkType === 'User' ? body.sys.updatedBy.sys.id : undefined;
  const assigneeId = configured || mover;
  if (!assigneeId) {
    return { action: 'none', reason: 'No assignee available for the review task; skipped.' };
  }

  await cma.task.create(
    { ...scope, entryId },
    {
      body: DEFAULT_REVIEW_BODY,
      status: 'active',
      assignedTo: { sys: { type: 'Link', linkType: 'User', id: assigneeId } },
    }
  );
  return { action: 'created', reason: 'Review task created; publishing is now gated.' };
}

/**
 * B. Review task resolved -> enforce four-eyes; re-open on self-review.
 */
export async function handleTaskEvent(
  body: TaskEventBody,
  context: FunctionEventContext
): Promise<HandlerResult> {
  const { oldTask, newTask, user } = body.sys;

  // Only act on an active -> resolved transition.
  if (!(oldTask?.status === 'active' && newTask.status === 'resolved')) {
    return { action: 'none', reason: 'Not an active->resolved transition; nothing to enforce.' };
  }

  // Only our review task (by body marker).
  const marker = markerOf(context);
  if (!newTask.body?.includes(marker)) {
    return { action: 'none', reason: 'Resolved task is not the gated review task; ignoring.' };
  }

  const entryId = newTask.sys.parentEntity?.sys.id;
  if (!entryId) {
    return { action: 'none', reason: 'Task has no parent entry; nothing to enforce.' };
  }

  const resolverId = user?.sys?.id ?? '';
  const scope = { spaceId: context.spaceId, environmentId: context.environmentId };
  const cma = context.cma;

  // Build the contributor set from entry sys + published snapshots.
  const entry = await cma.entry.get({ ...scope, entryId });
  const snapshotsResp = await cma.snapshot.getManyForEntry({ ...scope, entryId });
  const snapshots: Snapshot[] = snapshotsResp.items ?? [];
  const contributors = collectContributors(entry.sys, snapshots);

  // Evaluate four-eyes (resolver plays the role of "approver").
  const verdict = evaluateFourEyes({ approverId: resolverId, contributors });
  if (verdict.allowed) {
    return { action: 'none', reason: verdict.reason };
  }

  // Violation -> re-open the task (app owns it, so this is permitted), reassign to
  // the resolver (native notification), and explain why. Re-fetch for the version.
  const current: TaskLike = await cma.task.get({ ...scope, entryId, taskId: newTask.sys.id });
  const explanation =
    `${markerOf(context)}. This task was re-opened automatically because it was ` +
    `resolved by a contributor to this entry, which the four-eyes policy does not permit. ` +
    `A team member who did NOT edit this entry must review and resolve it before publishing.`;

  const reassignTo = resolverId
    ? { sys: { type: 'Link' as const, linkType: 'User' as const, id: resolverId } }
    : current.assignedTo;

  await cma.task.update(
    { ...scope, entryId, taskId: newTask.sys.id },
    { body: explanation, status: 'active', assignedTo: reassignTo, sys: { version: current.sys.version } }
  );

  return { action: 'reopened', reason: verdict.reason };
}

/**
 * Contentful Function entrypoint. Routes by topic to the create/enforce paths and
 * adapts to the void-returning AppEventHandler contract.
 */
export const handler = async (event: FunctionEvent, context: FunctionEventContext): Promise<void> => {
  const topic = event.headers?.['X-Contentful-Topic'] ?? '';
  let result: HandlerResult;
  if (topic.endsWith('Workflow.save')) {
    result = await handleWorkflowEvent(event.body as WorkflowEventBody, context);
  } else if (topic.endsWith('Task.save')) {
    result = await handleTaskEvent(event.body as TaskEventBody, context);
  } else {
    result = { action: 'none', reason: `Unhandled topic: ${topic}` };
  }
  console.log(`[four-eyes] ${result.action}: ${result.reason}`);
};

export default handler;
