import { describe, it, expect } from 'vitest';
import { collectContributors, evaluateFourEyes, type UserLink } from './fourEyes.js';

const userLink = (id: string): UserLink => ({ sys: { type: 'Link', linkType: 'User', id } });
const appLink = (id: string): UserLink => ({ sys: { type: 'Link', linkType: 'AppDefinition', id } });

describe('collectContributors', () => {
  it('includes creator, last editor, and every snapshot author', () => {
    const contributors = collectContributors(
      { createdBy: userLink('alice'), updatedBy: userLink('bob') },
      [{ sys: { createdBy: userLink('carol') } }, { sys: { createdBy: userLink('alice') } }]
    );
    expect([...contributors].sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('ignores app / non-user identities (e.g. migrations)', () => {
    const contributors = collectContributors(
      { createdBy: appLink('migration-app'), updatedBy: userLink('alice') },
      []
    );
    expect([...contributors]).toEqual(['alice']);
  });

  it('handles a never-published entry (no snapshots)', () => {
    const contributors = collectContributors({ createdBy: userLink('alice'), updatedBy: userLink('alice') }, []);
    expect([...contributors]).toEqual(['alice']);
  });
});

describe('evaluateFourEyes', () => {
  it('rejects when the approver contributed to the entry', () => {
    const contributors = collectContributors({ createdBy: userLink('alice') }, []);
    const result = evaluateFourEyes({ approverId: 'alice', contributors });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cannot approve an entry you contributed to/i);
  });

  it('allows when the approver is a different person', () => {
    const contributors = collectContributors({ createdBy: userLink('alice'), updatedBy: userLink('bob') }, []);
    const result = evaluateFourEyes({ approverId: 'carol', contributors });
    expect(result.allowed).toBe(true);
  });

  it('rejects the last editor even when the creator differs', () => {
    // Alice created, Bob heavily edited — Bob must not be able to self-approve.
    const contributors = collectContributors({ createdBy: userLink('alice'), updatedBy: userLink('bob') }, []);
    expect(evaluateFourEyes({ approverId: 'bob', contributors }).allowed).toBe(false);
  });

  it('fails closed when approver identity is unknown', () => {
    const contributors = collectContributors({ createdBy: userLink('alice') }, []);
    const result = evaluateFourEyes({ approverId: '', contributors });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/could not be determined/i);
  });
});
