/**
 * Pure four-eyes logic, separated from the Contentful runtime so it can be unit
 * tested without a live space. The handler in `approvalHandler.ts` wires these
 * pure functions to the CMA.
 *
 * "Author" here follows the SOC-grade definition agreed with Forge: the approver
 * must differ from ANY known contributor to the entry, not just the creator.
 *
 * Known limitation (documented for compliance sign-off): Contentful does not
 * expose a complete edit history. The contributor set we can build is:
 *   - sys.createdBy         (original creator)          — always available
 *   - sys.updatedBy         (last editor only)          — always available
 *   - snapshot.sys.createdBy for every published version — only exists post-publish
 * A never-published entry has no snapshots, so its contributor set is just
 * {createdBy, updatedBy}. This is strong in practice but is NOT a guaranteed
 * keystroke-complete history. See README "Compliance limitations".
 */

/** A Contentful Link to a User (or, for publishedBy, possibly an AppDefinition). */
export interface UserLink {
  sys: { type: 'Link'; linkType: 'User' | 'AppDefinition'; id: string };
}

export interface EntrySys {
  createdBy?: UserLink;
  updatedBy?: UserLink;
  publishedBy?: UserLink;
}

export interface Snapshot {
  sys: { createdBy?: UserLink };
}

/**
 * Build the set of user IDs considered "contributors" to an entry.
 * App/non-user identities are ignored — a machine identity can't be a reviewer,
 * and counting it would falsely block a human approver on migrated content.
 */
export function collectContributors(entrySys: EntrySys, snapshots: Snapshot[]): Set<string> {
  const ids = new Set<string>();
  const add = (link?: UserLink) => {
    if (link?.sys?.linkType === 'User' && link.sys.id) {
      ids.add(link.sys.id);
    }
  };

  add(entrySys.createdBy);
  add(entrySys.updatedBy);
  for (const snap of snapshots) {
    add(snap.sys?.createdBy);
  }
  return ids;
}

export interface FourEyesInput {
  /** User id of the person who advanced the workflow step (WorkflowsChangelog.eventBy). */
  approverId: string;
  /** Contributor ids from collectContributors(). */
  contributors: Set<string>;
}

export interface FourEyesResult {
  /** True when the approval is allowed to stand (approver is NOT a contributor). */
  allowed: boolean;
  /** Human-readable reason, surfaced to the user on rejection. */
  reason: string;
}

/**
 * The four-eyes check itself: an approval is allowed only if the approver did not
 * contribute to the entry. If the approver id is unknown/empty we FAIL CLOSED —
 * an unattributable approval must not be trusted for a compliance gate.
 */
export function evaluateFourEyes({ approverId, contributors }: FourEyesInput): FourEyesResult {
  if (!approverId) {
    return {
      allowed: false,
      reason: 'Approver identity could not be determined; approval rejected as a precaution.',
    };
  }
  if (contributors.has(approverId)) {
    return {
      allowed: false,
      reason:
        'You cannot approve an entry you contributed to. A different team member must review and approve it.',
    };
  }
  return { allowed: true, reason: 'Approver is not a contributor; approval permitted.' };
}
