/**
 * App Event handler (Contentful Function, invocation type `appevent.handler`).
 *
 * Trigger: an App Event subscription on topic `ContentManagement.Workflow.save`.
 * A workflow step change is delivered as `Workflow.save`, so this handler runs
 * automatically whenever any entry's workflow step changes — no webhook, no relay,
 * no external server. Verified against @contentful/node-apps-toolkit typings:
 * `AppEventPayloadMap.Workflow` defines create/save/delete, and AppEventHandler
 * receives `{ headers, body }` with the WorkflowProps body.
 *
 * The Function runs with the App Identity (context.cma is pre-initialized as that
 * identity). That identity MUST be granted workflow step-change permission in the
 * space, or the revert will 403.
 *
 * The "Approved" step id is configured as an app installation parameter
 * (`approvedStepId`) so it isn't hardcoded per environment.
 */
import { collectContributors, evaluateFourEyes, type Snapshot } from './fourEyes.js';

// Minimal shapes we rely on from the event/context (typed loosely to avoid
// pinning to a specific SDK version's exported names).
interface WorkflowEvent {
  headers: { 'X-Contentful-Topic'?: string } & Record<string, unknown>;
  body: {
    sys: { id: string; entity?: { sys: { id: string } } };
    stepId?: string;
  };
}

interface FunctionEventContext {
  spaceId: string;
  environmentId: string;
  appInstallationParameters: { approvedStepId?: string };
  // Pre-initialized CMA client authenticated as the App Identity.
  cma: any;
}

export interface HandlerResult {
  action: 'none' | 'reverted';
  reason: string;
}

/**
 * App Event handler. Returns void to Contentful (per AppEventHandlerResponse);
 * we return a HandlerResult too so this is unit-testable and logs are meaningful.
 */
export async function handleWorkflowEvent(
  event: WorkflowEvent,
  context: FunctionEventContext
): Promise<HandlerResult> {
  const approvedStepId = context.appInstallationParameters?.approvedStepId;
  if (!approvedStepId) {
    // Misconfiguration: without the Approved step id we can't know when to enforce.
    return { action: 'none', reason: 'No approvedStepId configured; enforcement skipped.' };
  }

  const workflow = event.body;
  const workflowId = workflow.sys.id;
  const entryId = workflow.sys.entity?.sys.id;

  // 1. Only act when the workflow just landed on the Approved step.
  if (workflow.stepId !== approvedStepId) {
    return { action: 'none', reason: 'Not the approved step; nothing to enforce.' };
  }
  if (!entryId) {
    return { action: 'none', reason: 'Workflow has no linked entry; nothing to enforce.' };
  }

  const scope = { spaceId: context.spaceId, environmentId: context.environmentId };
  const cma = context.cma;

  // 2. Who advanced the step? The most recent changelog entry for this entry.
  // NOTE: the workflows_changelog endpoint does NOT accept an `order` param
  // (returns 400 "Unknown parameter: order"). It already returns items
  // newest-first by default, so items[0] is the most recent step change.
  const changelog = await cma.workflowsChangelog.getMany({
    ...scope,
    query: {
      'entity.sys.id': entryId,
      'entity.sys.linkType': 'Entry',
      limit: 25,
    },
  });
  const items: any[] = changelog.items ?? [];
  const approverId: string = items[0]?.eventBy?.sys?.id ?? '';

  // 3. Build the contributor set from entry sys + published snapshots.
  const entry = await cma.entry.get({ ...scope, entryId });
  const snapshotsResp = await cma.snapshot.getManyForEntry({ ...scope, entryId });
  const snapshots: Snapshot[] = snapshotsResp.items ?? [];
  const contributors = collectContributors(entry.sys, snapshots);

  // 4. Evaluate the four-eyes rule.
  const verdict = evaluateFourEyes({ approverId, contributors });
  if (verdict.allowed) {
    return { action: 'none', reason: verdict.reason };
  }

  // 5. Violation → revert to the last step that wasn't the approved step.
  const previousStepId =
    items.map((i) => i.stepId).find((s: string) => s && s !== approvedStepId) ?? '';

  const current = await cma.workflow.get({ ...scope, workflowId });
  await cma.workflow.update({ ...scope, workflowId }, { ...current, stepId: previousStepId });

  return { action: 'reverted', reason: verdict.reason };
}

/**
 * Contentful Function entrypoint. The runtime calls the default export with
 * (event, context). We adapt to the void-returning AppEventHandler contract.
 */
export const handler = async (event: WorkflowEvent, context: FunctionEventContext): Promise<void> => {
  const topic = event.headers?.['X-Contentful-Topic'];
  // Defensive: only process Workflow.save (the subscription should already scope this).
  if (topic && !topic.endsWith('Workflow.save')) {
    return;
  }
  const result = await handleWorkflowEvent(event, context);
  // Surfaced in Function logs for observability.
  console.log(`[four-eyes] ${result.action}: ${result.reason}`);
};

export default handler;
