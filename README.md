# Contentful Four-Eyes Approval

A Contentful App Framework app that enforces a **four-eyes rule** on content review:
the person who **resolves the review task** on an entry must **not** be a contributor to
that entry. All authors can stay on one team with identical permissions, and the app
supplies the per-entry "not the author" check that Roles and Workflows cannot express on
their own.

> **Disclaimer:** This is sample code, not an official Contentful product or feature.
> It is provided as-is, without warranty, and is not covered by Contentful support or
> any SLA. Validate against a live space and have Compliance sign off on the
> limitations below before relying on it for SOC controls.

## Why this app is needed

- **Roles** grant or deny publish/step-change by static role. They cannot say
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
  4. If resolver ∈ contributors (or resolver unknown) → CREATE A FRESH unresolved
     review task (re-imposing the publish block), assigned to the resolver as a
     native "assigned to you" notification, with a body explaining why.
     Else → leave resolved → publishing is unblocked.
```

Publishing itself is **not** custom code. It stays native, gated by Contentful's
"unresolved task blocks publish" behavior. The only custom logic is creating the
review task and the resolver-vs-contributor check.

### Why a NEW task on self-review (not re-opening the resolved one)

An App Identity **cannot change a task's status back to `active`.** Even on a task
the app itself created, `task.update` (resolved → active) returns
`403 Forbidden` ("you don't have the permissions to make these updates on the task"),
proven empirically in a live space. Only `task.create` is permitted. So on a
self-review the app **creates a fresh, unresolved review task**, which re-imposes the
native publish block just as well; the old (resolved) task is simply left in place.

### The App Identity's real permissions on Tasks (measured, not documented)

This spike's core finding, the App Identity's actual capabilities against Task and
Workflow entities, established by live testing:

| Operation | Result |
| --- | --- |
| `task.create` (its own task) | ✅ works |
| `task.get` by id | ✅ works |
| `entry.get`, `snapshot.getManyForEntry` | ✅ works |
| `task.getMany` / list tasks | ❌ 403 "You are not allowed to query task" |
| `task.update` re-open (resolved → active), even on its own task | ❌ 403 "You don't have the permissions to make these updates on the task" |
| `PUT /workflows/{id}` (move a workflow step) | ❌ 403 (actor `app-function`) |

The create-new-blocker design is built entirely on the ✅ rows: create the task on
`Workflow.save`, read the entry/snapshots to build the contributor set, and create a
fresh blocking task on a self-review. It never relies on any ❌ operation.

### Why a Task, not a workflow step revert

An earlier design reverted the Workflow step when an author self-approved. **That is not
possible:** an App Identity is **not permitted to operate on `Workflow` /
`WorkflowDefinition` entities.** `PUT /workflows/{id}` returns `403 Forbidden` (actor
`app-function`), and there is no way to grant an app that permission (the
`workflow_permission.actors` field only accepts `"all"`, `User`, or `Team` links; apps
cannot be assigned a space Role). `Task` **is** in the app identity's allowed entity
types, so the app can create and update tasks as itself, with no service-account token
and no external server.

### Design decisions

- **Author = any known contributor**, not just the creator, so Author A creating and
  Author B rewriting means neither A nor B can clear the review.
- **Enforcement = a blocking review task only a non-contributor can clear.** On a
  self-review, the app creates a fresh blocking task (publish stays blocked) and
  notifies the resolver in-product by assigning it to them with an explanatory body.
- **Compute hosted on Contentful** as an App Event handler Function, with no webhook, no
  relay, and no server to run.

## Compliance limitations (read before sign-off)

**1. The contributor set is not keystroke-complete.** Contentful does not expose a
complete edit history. The contributor set this app can build is:

| Source | Coverage |
| --- | --- |
| `sys.createdBy` | Original creator; always present |
| `sys.updatedBy` | **Last** editor only; intermediate editors are not captured here |
| Published snapshots' `createdBy` | Author of each **published** version; a never-published entry has **no** snapshots |

Consequence: an entry edited by several people but never published, or with
intermediate edits between publishes, may not have every editor represented. This is
strong in practice but is **not** a guaranteed-complete contributor history. If you
require bulletproof "every editor who ever touched it," that needs a custom edit log
(out of scope for this build).

**2. The re-block is eventually consistent.** App Events are asynchronous (seconds of
latency). The hard, synchronous gate is the task itself: while it is unresolved,
Contentful blocks publishing. The four-eyes check on *resolution* is eventual, so there
is a brief window in which a contributor could self-resolve **and** publish in the ~1-3s
before the app creates the new blocking task. Practically this makes the four-eyes rule
a **strong deterrent / detective control** (a bypass is attributable and immediately
re-blocks the entry), **not** a synchronous hard gate on that one action. If a
zero-window synchronous gate is required, the resolution check must move to a
synchronous mechanism (e.g. an `appevent.filter` / entry-publish guard), which is a
larger change and a separate spike.

**3. Fails closed.** If the resolver's identity can't be determined, a fresh blocking
task is created anyway (never left unblocked on an unattributable action).

### Trigger: App Event, not a webhook or relay

The Function is invoked by an **App Event subscription** on topic
`ContentManagement.Task.save`. Confirmed against Contentful's own SDK typings
(`@contentful/node-apps-toolkit`): `AppEventPayloadMap.Task` defines
`create` / `save` / `delete`, and `SaveTaskEventPayload` delivers `sys.oldTask`,
`sys.newTask`, and `sys.user` (the actor who saved), with no webhook, no external relay,
and no self-hosted endpoint.

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
step's **stepId**, which you'll pass as `reviewStepId`. Do **not** have the workflow
create the review task itself; the app creates it, so the review task the app enforces
on is the only one and its body carries the marker the app matches. An unresolved task
blocks publishing natively, and that is the hard gate.

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
  notification hint only; anyone may resolve, and the four-eyes check catches the
  resolver). Falls back to whoever moved the entry to the review step.

> The App Identity needs no special grant here: creating/updating its OWN Tasks is
> within the app identity's allowed entity types.

### 4. Test

```bash
npm test        # pure four-eyes logic + handler behavior
npm run typecheck
```

Then, in the space: have an author resolve their own entry's review task and confirm a
fresh blocking task appears (assigned back to them with an explanation), keeping the
entry unpublishable; have a different (non-contributing) user resolve it and confirm it
stays resolved and the entry becomes publishable.

## Project layout

```
src/functions/
  fourEyes.ts         # pure, testable logic: contributor set + four-eyes verdict
  fourEyes.test.ts    # unit tests for the rule and edge cases
  approvalHandler.ts  # appevent.handler: wires the rule to the CMA + create-new-blocker
  approvalHandler.test.ts  # tests for the handler (reblock / allow / no-op / marker / fail-closed)
contentful-app-manifest.json  # Function declaration (appevent.handler)
```
