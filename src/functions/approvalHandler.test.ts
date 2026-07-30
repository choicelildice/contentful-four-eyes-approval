import { describe, it, expect, vi } from 'vitest';
import { handleWorkflowEvent } from './approvalHandler.js';

const userLink = (id: string) => ({ sys: { type: 'Link', linkType: 'User', id } });

/** Build a fake app-identity CMA client with the calls the handler makes. */
function makeCma(opts: {
  approverId: string;
  entryCreatedBy: string;
  updateSpy?: ReturnType<typeof vi.fn>;
}) {
  const changelogItems = [
    { stepId: 'step-approved', eventBy: userLink(opts.approverId) },
    { stepId: 'step-inreview', eventBy: userLink(opts.approverId) },
  ];
  return {
    workflowsChangelog: { getMany: vi.fn().mockResolvedValue({ items: changelogItems }) },
    entry: { get: vi.fn().mockResolvedValue({ sys: { createdBy: userLink(opts.entryCreatedBy) } }) },
    snapshot: { getManyForEntry: vi.fn().mockResolvedValue({ items: [] }) },
    workflow: {
      get: vi.fn().mockResolvedValue({ sys: { id: 'wf1' }, stepId: 'step-approved' }),
      update: opts.updateSpy ?? vi.fn().mockResolvedValue({}),
    },
  };
}

const baseEvent = {
  headers: { 'X-Contentful-Topic': 'ContentManagement.Workflow.save' },
  body: { sys: { id: 'wf1', entity: { sys: { id: 'entry1' } } }, stepId: 'step-approved' },
};
const ctx = (cma: any) => ({
  spaceId: 's',
  environmentId: 'master',
  appInstallationParameters: { approvedStepId: 'step-approved' },
  cma,
});

describe('handleWorkflowEvent', () => {
  it('reverts when the approver is the entry creator (self-approval)', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ approverId: 'alice', entryCreatedBy: 'alice', updateSpy: update });
    const result = await handleWorkflowEvent(baseEvent as any, ctx(cma) as any);
    expect(result.action).toBe('reverted');
    // Reverted to the last non-approved step from the changelog.
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stepId: 'step-inreview' })
    );
  });

  it('allows when a different person approved', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ approverId: 'bob', entryCreatedBy: 'alice', updateSpy: update });
    const result = await handleWorkflowEvent(baseEvent as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when the step is not the approved step', async () => {
    const cma = makeCma({ approverId: 'alice', entryCreatedBy: 'alice' });
    const event = { ...baseEvent, body: { ...baseEvent.body, stepId: 'step-inreview' } };
    const result = await handleWorkflowEvent(event as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(cma.entry.get).not.toHaveBeenCalled();
  });

  it('skips enforcement when approvedStepId is not configured', async () => {
    const cma = makeCma({ approverId: 'alice', entryCreatedBy: 'alice' });
    const badCtx = { ...ctx(cma), appInstallationParameters: {} };
    const result = await handleWorkflowEvent(baseEvent as any, badCtx as any);
    expect(result.action).toBe('none');
    expect(result.reason).toMatch(/no approvedstepid/i);
  });
});
