import { describe, it, expect, vi } from 'vitest';
import { handleTaskEvent } from './approvalHandler.js';

const userLink = (id: string) => ({ sys: { type: 'Link', linkType: 'User', id } });

/** Build a fake app-identity CMA client with the calls the handler makes. */
function makeCma(opts: {
  entryCreatedBy: string;
  taskVersion?: number;
  updateSpy?: ReturnType<typeof vi.fn>;
}) {
  return {
    entry: { get: vi.fn().mockResolvedValue({ sys: { createdBy: userLink(opts.entryCreatedBy) } }) },
    snapshot: { getManyForEntry: vi.fn().mockResolvedValue({ items: [] }) },
    task: {
      get: vi.fn().mockResolvedValue({
        sys: { id: 'task1', version: opts.taskVersion ?? 3 },
        body: 'Independent review required',
        status: 'resolved',
        assignedTo: userLink('someone'),
      }),
      update: opts.updateSpy ?? vi.fn().mockResolvedValue({}),
    },
  };
}

/** Build a Task.save event for an active->resolved transition by `resolverId`. */
const resolveEvent = (resolverId: string, body = 'Independent review required') => ({
  headers: { 'X-Contentful-Topic': 'ContentManagement.Task.save' },
  body: {
    sys: {
      user: userLink(resolverId),
      oldTask: { sys: { id: 'task1', version: 2 }, body, status: 'active' },
      newTask: {
        sys: { id: 'task1', version: 3, parentEntity: { sys: { id: 'entry1', linkType: 'Entry' } } },
        body,
        status: 'resolved',
      },
    },
  },
});

const ctx = (cma: any, params: Record<string, unknown> = {}) => ({
  spaceId: 's',
  environmentId: 'master',
  appInstallationParameters: params,
  cma,
});

describe('handleTaskEvent', () => {
  it('re-opens the task when a contributor resolves it (self-review)', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', updateSpy: update });
    const result = await handleTaskEvent(resolveEvent('alice') as any, ctx(cma) as any);
    expect(result.action).toBe('reopened');
    // Re-opened to active, reassigned to the resolver, with the current version.
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'active',
        assignedTo: expect.objectContaining({ sys: expect.objectContaining({ id: 'alice' }) }),
        sys: { version: 3 },
      })
    );
  });

  it('allows resolution by a non-contributor', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', updateSpy: update });
    const result = await handleTaskEvent(resolveEvent('bob') as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores events that are not an active->resolved transition', async () => {
    const cma = makeCma({ entryCreatedBy: 'alice' });
    const event = resolveEvent('alice');
    // Make it a resolved->resolved edit (no transition).
    (event.body.sys.oldTask as any).status = 'resolved';
    const result = await handleTaskEvent(event as any, ctx(cma) as any);
    expect(result.action).toBe('none');
    expect(cma.entry.get).not.toHaveBeenCalled();
  });

  it('ignores tasks whose body does not match the configured marker', async () => {
    const cma = makeCma({ entryCreatedBy: 'alice' });
    const result = await handleTaskEvent(
      resolveEvent('alice', 'Fix a typo') as any,
      ctx(cma, { reviewTaskMarker: 'Independent review' }) as any
    );
    expect(result.action).toBe('none');
    expect(cma.entry.get).not.toHaveBeenCalled();
  });

  it('enforces on the marked review task when a marker is configured', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', updateSpy: update });
    const result = await handleTaskEvent(
      resolveEvent('alice', 'Independent review required') as any,
      ctx(cma, { reviewTaskMarker: 'Independent review' }) as any
    );
    expect(result.action).toBe('reopened');
    expect(update).toHaveBeenCalled();
  });

  it('fails closed and re-opens when the resolver identity is unknown', async () => {
    const update = vi.fn().mockResolvedValue({});
    const cma = makeCma({ entryCreatedBy: 'alice', updateSpy: update });
    const event = resolveEvent('alice');
    delete (event.body.sys as any).user; // no actor -> unattributable
    const result = await handleTaskEvent(event as any, ctx(cma) as any);
    expect(result.action).toBe('reopened');
    // With no resolver id we keep the existing assignee rather than a bogus link.
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'active' })
    );
  });
});
