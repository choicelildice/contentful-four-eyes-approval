/**
 * App Action handler (Contentful Function, invocation type `appaction.call`).
 *
 * Trigger chain:
 *   Webhook on `Workflow.save`  →  this App Action  →  four-eyes check  →  revert if violated
 *
 * We use a webhook + App Action rather than an App Event handler because, as of
 * this build, App Events only document support for entry/content-type/asset
 * topics — Workflow is NOT a confirmed App Event topic. `Workflow.save` IS a
 * confirmed webhook topic, so the webhook is the reliable trigger.
 *
 * The Function runs with the App Identity. That identity MUST be granted
 * workflow step-change permission in the space, or the revert PUT will 403.
 *
 * Expected App Action parameters (sent by the webhook payload mapping):
 *   - workflowId:   sys.id of the Workflow entity that was saved
 *   - entryId:      sys.id of the entry the workflow is attached to
 *   - approvedStepId: the stepId we treat as "Approved" (from WorkflowDefinition)
 */
import { collectContributors, evaluateFourEyes, type Snapshot } from './fourEyes.js';

interface AppActionRequest {
  body: {
    workflowId: string;
    entryId: string;
    approvedStepId: string;
  };
}

interface FunctionEventContext {
  spaceId: string;
  environmentId: string;
  // Pre-initialized CMA client, authenticated as the App Identity.
  cmaClientOptions: unknown;
}

// The concrete CMA client type comes from contentful-management; kept loose here
// so this file documents the flow without pinning to a specific SDK shape.
type Cma = any;

export interface HandlerDeps {
  /** Factory so tests can inject a fake CMA. In production, build from context.cmaClientOptions. */
  getCma: (context: FunctionEventContext) => Cma;
}

export interface HandlerResult {
  status: 'succeeded' | 'failed';
  action: 'none' | 'reverted';
  reason: string;
}

export async function handleApproval(
  event: AppActionRequest,
  context: FunctionEventContext,
  deps: HandlerDeps
): Promise<HandlerResult> {
  const { workflowId, entryId, approvedStepId } = event.body;
  const cma = deps.getCma(context);
  const scope = { spaceId: context.spaceId, environmentId: context.environmentId };

  // 1. Read the workflow; only act if it just landed on the Approved step.
  const workflow = await cma.workflow.get({ ...scope, workflowId });
  if (workflow.stepId !== approvedStepId) {
    return { status: 'succeeded', action: 'none', reason: 'Not the approved step; nothing to enforce.' };
  }

  // 2. Find who advanced the step: the most recent changelog entry for this entry.
  const changelog = await cma.workflowsChangelog.getMany({
    ...scope,
    query: { 'entity.sys.id': entryId, 'entity.sys.linkType': 'Entry', order: '-sys.createdAt', limit: 1 },
  });
  const latest = changelog.items?.[0];
  const approverId: string = latest?.eventBy?.sys?.id ?? '';

  // 3. Build the contributor set from entry sys + published snapshots.
  const entry = await cma.entry.get({ ...scope, entryId });
  const snapshotsResp = await cma.snapshot.getManyForEntry({ ...scope, entryId });
  const snapshots: Snapshot[] = snapshotsResp.items ?? [];
  const contributors = collectContributors(entry.sys, snapshots);

  // 4. Evaluate the rule.
  const verdict = evaluateFourEyes({ approverId, contributors });
  if (verdict.allowed) {
    return { status: 'succeeded', action: 'none', reason: verdict.reason };
  }

  // 5. Violation → revert to the previous step. We revert to the step recorded
  //    just before the approval in the changelog, falling back to the workflow
  //    definition's first step if history is unavailable.
  const previousStepId = await resolvePreviousStep(cma, scope, entryId, approvedStepId);
  await cma.workflow.update(
    { ...scope, workflowId },
    { ...workflow, stepId: previousStepId }
  );

  return { status: 'failed', action: 'reverted', reason: verdict.reason };
}

/**
 * Resolve the step to revert to: the last changelog step that was NOT the approved
 * step. Falls back to the workflow definition's first step if none is found.
 */
async function resolvePreviousStep(
  cma: Cma,
  scope: { spaceId: string; environmentId: string },
  entryId: string,
  approvedStepId: string
): Promise<string> {
  const history = await cma.workflowsChangelog.getMany({
    ...scope,
    query: { 'entity.sys.id': entryId, 'entity.sys.linkType': 'Entry', order: '-sys.createdAt', limit: 25 },
  });
  const priorStep = (history.items ?? [])
    .map((i: any) => i.stepId)
    .find((stepId: string) => stepId && stepId !== approvedStepId);
  return priorStep ?? '';
}
