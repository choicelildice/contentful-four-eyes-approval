# Contentful Four-Eyes Approval

A Contentful App Framework app that enforces a **four-eyes rule** on content approval:
the person who advances an entry's Workflow to the **Approved** step must **not** be a
contributor to that entry. All authors can stay on one team with identical permissions —
the app supplies the per-entry "not the author" check that Roles and Workflows cannot
express on their own.

> Built for the Forge Global engagement. Sample/reference implementation — validate
> against a live space and have Compliance sign off on the limitations below before
> relying on it for SOC controls.

## Why this app is needed

- **Roles** grant or deny publish/step-change by static role — they cannot say
  "everyone except whoever authored *this* entry."
- **Workflows** (Premium; Forge has it) provide the stages and can block publishing until
  the `Approved` step — but they gate step transitions by **role**, not by identity
  relative to the entry. On a single-team setup, an author is in the same role as
  reviewers and can advance their own entry.

This app fills exactly that gap and nothing else.

## How it works

```
Author edits entry, moves Workflow: Draft → In Review   (cannot publish; publish is
                                                          gated to the Approved step)
        │
Reviewer moves Workflow: In Review → Approved
        │
Contentful fires an App Event: ContentManagement.Workflow.save
        │
The subscribed Contentful Function (appevent.handler) runs automatically,
as the App Identity:
  1. Confirm the workflow is on the Approved step
  2. Read WorkflowsChangelog → who advanced it (eventBy)
  3. Build contributor set: entry sys.createdBy + sys.updatedBy + every
     published snapshot's createdBy
  4. If approver ∈ contributors → revert workflow to the prior step (403-safe
     only if the App Identity holds workflow step-change permission)
     Else → allow (publish stays natively gated to Approved)
```

Publishing itself is **not** custom code — it stays native, gated by the Workflow's
`Approved` step. The only custom logic is the approver-vs-contributor check.

### Design decisions (agreed with Forge)

- **Author = any known contributor**, not just the creator — so Author A creating and
  Author B rewriting means neither A nor B can self-approve.
- **On violation: revert to the prior step** (the last changelog step before `Approved`)
  and return a rejection reason for the UI to surface.
- **Compute hosted on Contentful** as an App Event handler Function — no webhook, no
  relay, and no server for Forge to run.

## Compliance limitations (read before sign-off)

Contentful does **not** expose a complete, keystroke-level edit history. The contributor
set this app can build is:

| Source | Coverage |
| --- | --- |
| `sys.createdBy` | Original creator — always present |
| `sys.updatedBy` | **Last** editor only — intermediate editors are not captured here |
| Published snapshots' `createdBy` | Author of each **published** version — a never-published entry has **no** snapshots |

Consequence: an entry edited by several people but never published, or with
intermediate edits between publishes, may not have every editor represented. This is
strong in practice but is **not** a guaranteed-complete contributor history. If Forge
requires bulletproof "every editor who ever touched it," that needs a custom edit log
(out of scope for this build).

The check **fails closed**: if the approver's identity can't be determined, the approval
is rejected.

### Trigger: App Event, not a webhook or relay

The Function is invoked by an **App Event subscription** on topic
`ContentManagement.Workflow.save`. A workflow step change is delivered as
`Workflow.save`, so the handler runs automatically on every step change — no
webhook, no external relay server, no self-hosted endpoint.

This is confirmed by Contentful's own SDK typings
(`@contentful/node-apps-toolkit`): `AppEventPayloadMap.Workflow` defines
`create` / `save` / `delete`, and an `appevent.handler` Function receives the
`WorkflowProps` body. Note the public docs do **not** enumerate Workflow among
App Event topics (they only mention entries/assets/content types), so **validate
once empirically** in a test space — but the SDK contract makes it the expected
outcome.

`Workflow.complete` is NOT an App Event topic; a completed workflow surfaces via
`save`/`delete`. This app keys off `save`.

## Setup

### Prerequisites

- Node.js 18+
- A Contentful space on a **Premium/Enterprise** plan (Workflows required)
- Contentful CLI + `@contentful/app-scripts`

### 1. Configure the Workflow

In the space, create/adjust the Workflow definition so that:
- Publishing is **disabled** on `Draft` and `In Review`
- Publishing is **allowed only** on `Approved`

Note the **stepId** of the `Approved` step — you'll pass it as `approvedStepId`.

### 2. Build and upload the app (incl. the Function)

```bash
npm install
npm run build
npm run upload -- --organization-id YOUR_ORG_ID
```

### 3. Grant the App Identity workflow step-change permission

The Function reverts the step **as the App Identity**. That identity must hold
workflow step-change permission for the target steps, or the revert `PUT` returns 403.

### 4. Subscribe the App Event

In the app's **Events** tab (or via the CMA `AppEventSubscription`), subscribe the
Function to topic **`ContentManagement.Workflow.save`**. No payload mapping or URL
is needed — the Function receives the workflow entity directly.

Set the **`approvedStepId`** app installation parameter to the `stepId` of the
Approved step from step 1 (the Function reads it from
`context.appInstallationParameters`).


### 5. Test

```bash
npm test        # pure four-eyes logic
npm run typecheck
```

Then, in the space: have an author advance their own entry to `Approved` and confirm it
is reverted; have a different user approve and confirm it stands.

## Project layout

```
src/functions/
  fourEyes.ts         # pure, testable logic: contributor set + four-eyes verdict
  fourEyes.test.ts    # unit tests for the rule and edge cases
  approvalHandler.ts  # appevent.handler: wires the rule to the CMA + revert
  approvalHandler.test.ts  # tests for the handler (revert / allow / no-op / misconfig)
contentful-app-manifest.json  # Function declaration (appevent.handler)
```
