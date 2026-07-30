import { describe, it, expect, vi } from 'vitest';
import { handleTaskEvent, handleWorkflowEvent } from './approvalHandler.js';

const userLink = (id: string) => ({ sys: { type: 'Link', linkType: 'User', id } });
const REVIEW_BODY = 'Independent review required: please review before publishing.';

/** Build a fake app-identity CMA client with the calls the handlers make. */
function makeCma(opts: {
  entryCreatedBy?: string;
  taskVersion?: number;
  existingTasks?: any[];
  updateSpy?: ReturnType<typeof vi.fn>;
  createSpy?: ReturnType<typeof vi.fn>;
}) {
  return {
    entry: {
      get: vi.fn().mockResolvedValue({ sys: { createdBy: userLink(opts.entryCreatedBy ?? 'alice') } }),
    },
    snapshot: { getManyForEntry: vi.fn().mockResolvedValue({ items: [] }) },
    task: {
      getMany: vi.fn().mockResolvedValue({ items: opts.existingTasks ?? [] }),
      get: vi.fn().mockResolvedValue({
        sys: { id: 'task1', version: opts.taskVersion ?? 3 },
        body: REVIEW_BODY,
        status: 'resolved',
        assignedTo: userLink('someone'),
      }),
      create: opts.createSpy ?? vi.fn().mockResolvedValue({}),
      update: opts.updateSpy ?? vi.fn().mockResolvedValue({}),
    },
  };
}

/** Task.save event body for an active->resolved transition by `resolverId`. */
const resolveBody = (resolverId: string | null, body = REVIEW_BODY) => ({
  sys: {
    ...(resolverId ? { user: userLink(resolverId) } : {}),
    oldTask: { sys: { id: 'task1', version: 2 }, body, status: 'active' },
    newTask: {
      sys: { id: 'task1', version: 3, parentEntity: { sys: { id: 'entry1', linkType: 'Entry' } } },
      body,
      status: 'resolved',
    },
  },
});

/** Workflow.save event body landing on `stepId`, moved by `moverId`. */
const workflowBody = (stepId: string, moverId = 'alice') => ({
  stepId,
  sys: { id: 'wf1', entity: { sys: { id: 'entry1' } }, updatedBy: userLink(moverId) },
});

const ctx = (cma: any, params: Record<string, unknown> = {}) => ({
  spaceId: 's',
  environmentId: 'master',
  appInstallationParameters: params,
  cma,
});

describe('handleWorkflowEvent (app creates & owns the review task)', () => {
  it('creates the review task when the entry reaches the review step', async () => {
    const create = vi.fn().mockResolvedValue({});
    const cma = makeCma({ createSpy: create });
    const result = await handleWorkflowEvent(
      workflowBody('step-review', 'alice') as any,
      ctx(cma, { reviewStepId: 'step-review' }) as any
    );
    expect(result.action).toBe('created');
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'active' })
    );
  });

  it('does nothing on a non-review step', async () => {
    const create = vi.fn();
    const cma = makeCma({ createSpy: create });
    const result = await handleWorkflowEvent(
      workflowBody('step-draft') as any,
      ctx(cma, { reviewStepId: 'step-review' }) as any
    );
    expect(result.action).toBe('none');
    expect(create).not.toHaveBeenCalled();
  });

  it('skips when no reviewStepId is configured', async () => {
    const cma = makeCma({});
    const result = await handleWorkflowEvent(workflowBody('step-review') as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(result.reason).toMatch(/no reviewstepid/i);
  });
});

describe('handleTaskEvent (four-eyes enforcement on resolve)', () => {
  it('creates a fresh blocking task when a contributor resolves it (self-review)', async () => {
    const create = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', createSpy: create });
    const result = await handleTaskEvent(resolveBody('alice') as any, ctx(cma) as any);
    expect(result.action).toBe('reblocked');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'entry1' }),
      expect.objectContaining({
        status: 'active',
        assignedTo: expect.objectContaining({ sys: expect.objectContaining({ id: 'alice' }) }),
      })
    );
  });

  it('allows resolution by a non-contributor', async () => {
    const create = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', createSpy: create });
    const result = await handleTaskEvent(resolveBody('bob') as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores events that are not an active->resolved transition', async () => {
    const cma = makeCma({ entryCreatedBy: 'alice' });
    const body = resolveBody('alice');
    (body.sys.oldTask as any).status = 'resolved';
    const result = await handleTaskEvent(body as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(cma.entry.get).not.toHaveBeenCalled();
  });

  it('ignores tasks whose body does not contain the review marker', async () => {
    const cma = makeCma({ entryCreatedBy: 'alice' });
    const result = await handleTaskEvent(resolveBody('alice', 'Fix a typo') as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(cma.entry.get).not.toHaveBeenCalled();
  });

  it('fails closed and re-blocks when the resolver identity is unknown', async () => {
    const create = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', createSpy: create });
    const result = await handleTaskEvent(resolveBody(null) as any, ctx(cma) as any);
    expect(result.action).toBe('reblocked');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'entry1' }),
      expect.objectContaining({ status: 'active' })
    );
  });
});
