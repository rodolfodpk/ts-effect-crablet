# ADR-0053: A model may declare its states, and the framework checks, draws and explores them

## Status

**Rejected** (2026-11-22). Nothing built. Proposed on 2026-11-18, inspired by XState's statecharts and `@xstate/graph`; rejected on review.
[ADR-0025](0025-the-framework-turns-the-period.md) stands: a model "models no states or transitions, which stay in `decide`".

## Context

The proposal added `.states(initial, table)` to the model builder: a table of the events allowed in each state and the state each leads to,
written beside the handlers.

```ts
.states("none", {
  none: { CourseDefined: "open" },
  open: { StudentSubscribed: "open", SubscriptionReleased: "open", CourseCancelled: "cancelled" },
  cancelled: {}
})
```

From it the framework would fold a `status` that `decide` reads instead of flags (`exists`, `cancelled`), fail as a defect an append the table
refused, draw the table as Mermaid, and generate test paths covering every transition.

## Decision

Not adopted. States and transitions stay in `decide`. A model whose entity moves through states writes its state as a discriminated union in
the fold, as `CourseReadiness` (`examples/course-enrolment-app/src/domain/CourseStart.ts`) already does with its `status`:

```ts
type Course =
  | { readonly status: "none" }
  | { readonly status: "open"; readonly capacity: number; readonly subscribers: number }
  | { readonly status: "cancelled" };
```

The type checker then narrows the state in `decide`: `capacity` exists only once `status === "open"` is known.

## Why

1. **The machine is already there.** `decide` is the transition of commands (state and command to events) and the fold the transition of events
   (state and event to state): the decider pattern. A table is a second, partial encoding of the same rules.
2. **It breaks the model's own rule.** The fold and the boundary come from one declaration "so the fold and the boundary cannot drift apart"
   (`packages/commands/src/Model.ts`). The table is a second declaration of each event beside its handler, and a rule written twice, in
   `decide` and in the table.
3. **With DCB it cannot be enforced.** Each decision loads the models it needs, so the table would be checked only by the commands that load its
   model: `CancelUnreadyCourse` appends `CourseCancelled` with `CourseReadiness` and never consults `CourseModel`. Events are facts, so the load
   would have to accept any sequence. What is left is documentation with a cost at run time.
4. **Declaring it would change consistency.** For a commutative command guarded by the lifecycle query (`concurrent({ guard })`) to see a
   change of status, every event that changes the status would have to become a `.lifecycle` event. A declaration meant to describe would
   change which appends conflict.
5. **The review kept patching it.** The lifecycle requirement, a rule for which state an unexpected event leads to, and "checked only for the
   models a command loads" were each needed to keep it coherent; each was a sign that the unit, an entity's machine, does not fit a log that
   no entity owns.

## What XState offered, and where it lives here

- **Readable states**: a discriminated union in the fold, with no framework change.
- **Tests that cover the transitions**: Given/When/Then specs over commands (`given(...).when(...)`, `packages/commands/src/testing/Scenario.ts`).
- **A drawing**: Event Modeling (commands, events and views on a timeline), which is the picture of a DCB system, rather than a statechart per
  entity.
