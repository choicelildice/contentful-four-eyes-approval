/**
 * App Event handler (Contentful Function, invocation type `appevent.handler`).
 *
 * Enforcement model: a BLOCKING REVIEW TASK that only a non-contributor may clear.
 *
 * Contentful blocks publishing while an entry has any unresolved Task, so the
 * task itself is the hard, synchronous gate. This Function supplies the piece
 * Contentful can't: it ensures the person who *resolves* that review task is not
 * a contributor to the entry (the four-eyes rule).
 *
 *   1. The Workflow natively creates an "Independent review required" task when an
 *      entry reaches the review step (publishing is blocked while it's open).
 *   2. Someone resolves the task -> Contentful fires `ContentManagement.Task.save`.
 *   3. This handler runs as the App Identity and checks the resolver against the
 *      entry's contributor set:
 *        - resolver is NOT a contributor -> leave resolved -> publish unblocked.
 *        - resolver IS a contributor (self-review) -> RE-OPEN the task (status
 *          back to `active`), reassign it to the resolver so Contentful sends them
 *          a native "assigned to you" notification, and rewrite the task body to
 *          explain why. Publishing stays blocked.
 *
 * Why Tasks and not the Workflow step: an App Identity is NOT permitted to operate
 * on Workflow/WorkflowDefinition entities (a `PUT /workflows/{id}` returns 403,
 * actor `app-function`). `Task` IS in the app identity's allowed entity types, so
 * the app can create and update tasks as itself — no service-account token needed.
 *
 * Known limitation (for compliance sign-off): App Events are asynchronous (seconds
 * of latency). The task-blocks-publish gate is synchronous and hard, but the
 * four-eyes check on *resolution* is eventual — there is a brief window in which a
 * contributor could self-resolve and publish before this handler re-opens the task.
 * Documented in the README; the synchronous gate is the task itself.
 *
 * Verified against @contentful/node-apps-toolkit typings: `AppEventPayloadMap.Task`
 * defines create/save/delete; `SaveTaskEventPayload` carries `sys.oldTask`,
 * `sys.newTask`, and `sys.user` (the actor who saved). `TaskProps` carries
 * `status` ('active' | 'resolved'), `sys.parentEntity` (Link<'Entry'>), and
 * `sys.version`.
 */
import { collectContributors, evaluateFourEyes, type Snapshot } from './fourEyes.js';

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

// Task.save event body (see SaveTaskEventPayload in the toolkit typings).
interface TaskEvent {
  headers: { 'X-Contentful-Topic'?: string } & Record<string, unknown>;
  body: {
    sys: {
      user?: { sys: { id: string } };
      oldTask?: TaskLike;
      newTask: TaskLike;
    };
  };
}

interface FunctionEventContext {
  spaceId: string;
  environmentId: string;
  // Optional substring the review-task body must contain for the gate to apply.
  // If unset, four-eyes is enforced on EVERY task resolution (fails toward enforcing).
  appInstallationParameters: { reviewTaskMarker?: string };
  // Pre-initialized CMA client authenticated as the App Identity.
  cma: any;
}

export interface HandlerResult {
  action: 'none' | 'reopened';
  reason: string;
}

/**
 * Core handler. Returns a HandlerResult so it is unit-testable and logs are
 * meaningful; the runtime entrypoint (default export) adapts to the void contract.
 */
export async function handleTaskEvent(
  event: TaskEvent,
  context: FunctionEventContext
): Promise<HandlerResult> {
  const { oldTask, newTask, user } = event.body.sys;

  // 1. Only act on an active -> resolved transition. Anything else (edits,
  //    re-opens, creation) is not a review being cleared.
  if (!(oldTask?.status === 'active' && newTask.status === 'resolved')) {
    return { action: 'none', reason: 'Not an active->resolved transition; nothing to enforce.' };
  }

  // 2. Optionally scope to the designated review task by a body marker.
  const marker = context.appInstallationParameters?.reviewTaskMarker?.trim();
  if (marker && !newTask.body?.includes(marker)) {
    return { action: 'none', reason: 'Resolved task is not the gated review task; ignoring.' };
  }

  const entryId = newTask.sys.parentEntity?.sys.id;
  if (!entryId) {
    return { action: 'none', reason: 'Task has no parent entry; nothing to enforce.' };
  }

  // 3. Who resolved it? The actor on the save event.
  const resolverId = user?.sys?.id ?? '';

  const scope = { spaceId: context.spaceId, environmentId: context.environmentId };
  const cma = context.cma;

  // 4. Build the contributor set from entry sys + published snapshots.
  const entry = await cma.entry.get({ ...scope, entryId });
  const snapshotsResp = await cma.snapshot.getManyForEntry({ ...scope, entryId });
  const snapshots: Snapshot[] = snapshotsResp.items ?? [];
  const contributors = collectContributors(entry.sys, snapshots);

  // 5. Evaluate four-eyes (resolver plays the role of "approver").
  const verdict = evaluateFourEyes({ approverId: resolverId, contributors });
  if (verdict.allowed) {
    return { action: 'none', reason: verdict.reason };
  }

  // 6. Violation -> re-open the task so publishing stays blocked, reassign it to
  //    the resolver (native "assigned to you" notification), and explain why in
  //    the body. Re-fetch for the current version to avoid a version conflict.
  const current: TaskLike = await cma.task.get({ ...scope, entryId, taskId: newTask.sys.id });
  const explanation =
    `Independent review required. This task was re-opened automatically because it ` +
    `was resolved by a contributor to this entry, which the four-eyes policy does not ` +
    `permit. A team member who did NOT edit this entry must review and resolve it before ` +
    `it can be published.`;

  const reassignTo = resolverId
    ? { sys: { type: 'Link' as const, linkType: 'User' as const, id: resolverId } }
    : current.assignedTo;

  await cma.task.update(
    { ...scope, entryId, taskId: newTask.sys.id },
    {
      body: explanation,
      status: 'active',
      assignedTo: reassignTo,
      sys: { version: current.sys.version },
    }
  );

  return { action: 'reopened', reason: verdict.reason };
}

/**
 * Contentful Function entrypoint. Adapts to the void-returning AppEventHandler
 * contract; logs the result for observability.
 */
export const handler = async (event: TaskEvent, context: FunctionEventContext): Promise<void> => {
  const topic = event.headers?.['X-Contentful-Topic'];
  // Defensive: only process Task.save (the subscription should already scope this).
  if (topic && !topic.endsWith('Task.save')) {
    return;
  }
  const result = await handleTaskEvent(event, context);
  console.log(`[four-eyes] ${result.action}: ${result.reason}`);
};

export default handler;
