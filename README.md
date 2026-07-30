# Contentful Four-Eyes Approval

A Contentful App Framework app that enforces a **four-eyes rule** on content review:
the person who **resolves the review task** on an entry must **not** be a contributor to
that entry. All authors can stay on one team with identical permissions — the app
supplies the per-entry "not the author" check that Roles and Workflows cannot express on
their own.

> Built for the Forge Global engagement. Sample/reference implementation — validate
> against a live space and have Compliance sign off on the limitations below before
> relying on it for SOC controls.

## Why this app is needed

- **Roles** grant or deny publish/step-change by static role — they cannot say
  "everyone except whoever authored *this* entry."
- **Workflows** (Premium) provide the stages and can create a review **Task**; an open
  Task blocks publishing. But neither Roles nor Workflows can say the *resolver* of that
  task must differ from the entry's author. On a single-team setup, an author is in the
  same role as reviewers and can resolve their own review task.

This app fills exactly that gap and nothing else.

## How it works

```
Author edits entry, moves Workflow → In Review
        │
Contentful fires App Event: ContentManagement.Workflow.save
        │
The Function (as the App Identity) CREATES a review Task it OWNS
("Independent review required")
        │   ← an unresolved Task BLOCKS publishing (native Contentful behavior)
        │
Someone resolves the review Task
        │
Contentful fires App Event: ContentManagement.Task.save
        │
The same Function runs again, as the App Identity:
  1. Confirm this is an active → resolved transition of the review task
  2. Read the resolver from the event (sys.user)
  3. Build contributor set: entry sys.createdBy + sys.updatedBy + every
     published snapshot's createdBy
  4. If resolver ∈ contributors (or resolver unknown) → RE-OPEN the task
     (status → active), reassign it to the resolver (native "assigned to you"
     notification), and rewrite the body to explain why. Publish stays blocked.
     Else → leave resolved → publishing is unblocked.
```

Publishing itself is **not** custom code — it stays native, gated by Contentful's
"unresolved task blocks publish" behavior. The only custom logic is creating the
review task and the resolver-vs-contributor check.

### Why the APP creates the task (not the Workflow)

Contentful only lets a task's **creator** (or an admin) re-open/edit it. A task
created by the Workflow engine is owned by a *different* identity, so the app gets a
`403 Forbidden` ("you don't have the permissions to make these updates on the task")
when it tries to re-open it. Therefore the **app** must create the review task — on
the `Workflow.save` event when the entry reaches the review step — so it owns the
task and can re-open it on a self-review. Creation is idempotent (it won't add a
second active review task if one already exists).

### Why a Task, not a workflow step revert

An earlier design reverted the Workflow step when an author self-approved. **That is not
possible:** an App Identity is **not permitted to operate on `Workflow` /
`WorkflowDefinition` entities** — `PUT /workflows/{id}` returns `403 Forbidden` (actor
`app-function`), and there is no way to grant an app that permission (the
`workflow_permission.actors` field only accepts `"all"`, `User`, or `Team` links; apps
cannot be assigned a space Role). `Task` **is** in the app identity's allowed entity
types, so the app can create and update tasks as itself — no service-account token, no
external server.

### Design decisions (agreed with Forge)

- **Author = any known contributor**, not just the creator — so Author A creating and
  Author B rewriting means neither A nor B can clear the review.
- **Enforcement = a blocking review task only a non-contributor can clear.** On a
  self-review, the app re-opens the task (publish stays blocked) and notifies the
  resolver in-product by reassigning it to them with an explanatory body.
- **Compute hosted on Contentful** as an App Event handler Function — no webhook, no
  relay, and no server for Forge to run.

## Compliance limitations (read before sign-off)

**1. The contributor set is not keystroke-complete.** Contentful does not expose a
complete edit history. The contributor set this app can build is:

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

**2. The re-open is eventually consistent.** App Events are asynchronous (seconds of
latency). The hard, synchronous gate is the task itself: while it is unresolved,
Contentful blocks publishing. The four-eyes check on *resolution* is eventual, so there
is a brief window in which a contributor could self-resolve **and** publish in the ~1–3s
before the app re-opens the task. If that window is unacceptable, the resolution check
must move to a synchronous mechanism (e.g. an `appevent.filter` / entry-publish guard),
which is a larger change.

**3. Fails closed.** If the resolver's identity can't be determined, the task is
re-opened (never left resolved on an unattributable action).

### Trigger: App Event, not a webhook or relay

The Function is invoked by an **App Event subscription** on topic
`ContentManagement.Task.save`. Confirmed against Contentful's own SDK typings
(`@contentful/node-apps-toolkit`): `AppEventPayloadMap.Task` defines
`create` / `save` / `delete`, and `SaveTaskEventPayload` delivers `sys.oldTask`,
`sys.newTask`, and `sys.user` (the actor who saved) — no webhook, no external relay, no
self-hosted endpoint.

> Note: the `Workflow.save` topic **does** fire on workflow step changes (validated
> empirically in a test space), but it is not used here because the app cannot act on
> Workflow entities. The task-based model is what an App Identity can actually enforce.

## Setup

### Prerequisites

- Node.js 18+
- A Contentful space on a **Premium/Enterprise** plan (Workflows + Tasks required)
- Contentful CLI + `@contentful/app-scripts`

### 1. Configure the Workflow

In the space, create a Workflow with a review step (e.g. "In Review"). Note that
step's **stepId** — you'll pass it as `reviewStepId`. Do **not** have the workflow
create the review task itself; the app creates it (so the app owns it and can re-open
it). An unresolved task blocks publishing natively — that is the hard gate.

### 2. Build and upload the app (incl. the Function)

```bash
npm install
npm run build
npm run upload -- --organization-id YOUR_ORG_ID
```

### 3. Subscribe the App Event

In the app's **Events** tab (or via the CMA `AppEventSubscription`), subscribe the
Function to **both** topics: **`ContentManagement.Workflow.save`** (to create the review
task) and **`ContentManagement.Task.save`** (to enforce on resolve). No payload mapping
or URL is needed.

Set installation parameters:
- **`reviewStepId`** (required): the workflow stepId at which the app creates the review
  task (from step 1).
- **`reviewTaskMarker`** (optional): substring the review task's body contains; the app
  only enforces four-eyes on tasks whose body includes it. Defaults to
  `Independent review required` (the body the app itself writes).
- **`reviewAssigneeId`** (optional): user id to assign the created task to (a
  notification hint only — anyone may resolve; the four-eyes check catches the resolver).
  Falls back to whoever moved the entry to the review step.

> The App Identity needs no special grant here: creating/updating its OWN Tasks is
> within the app identity's allowed entity types.

### 4. Test

```bash
npm test        # pure four-eyes logic + handler behavior
npm run typecheck
```

Then, in the space: have an author resolve their own entry's review task and confirm it
is re-opened (and reassigned back to them with an explanation); have a different user
resolve it and confirm it stays resolved and the entry becomes publishable.

## Project layout

```
src/functions/
  fourEyes.ts         # pure, testable logic: contributor set + four-eyes verdict
  fourEyes.test.ts    # unit tests for the rule and edge cases
  approvalHandler.ts  # appevent.handler: wires the rule to the CMA + task re-open
  approvalHandler.test.ts  # tests for the handler (reopen / allow / no-op / marker / fail-closed)
contentful-app-manifest.json  # Function declaration (appevent.handler)
```
