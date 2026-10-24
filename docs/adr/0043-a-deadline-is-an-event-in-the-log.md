# ADR-0043: A deadline is an event in the log, and a processor runs its command when it is due

## Status

**Proposed** (2026-10-24). Nothing built, and nothing needs it yet: it is to be built when an application does. It answers the gap the
[Aggregate events](../guides/build/aggregate-events.md) guide names, an Aggregator's expiry, and records why the state stays in the log rather than in
Effect's workflow engine.

## Context

A command can decide only when something asks it to: a request, or an automation woken by an event. Nothing runs a command because **time passed**:

- An Aggregator that never completes waits forever ("close enrolment with what is there after a week").
- A process with a timeout (a payment not captured within 30 minutes, a reservation held for 15) has to be swept by a job outside the application.
- A period is turned lazily, in the append of the next command that writes into it (ADR-0025). That is right for a balance, but nothing *happens* at
  the turn: a statement is not sent at midnight.

Today an application writes the sweep itself: a cron job, a query for what is overdue, and a command. Each app re-does the query, the sweep's
idempotency and its leadership, and the time something was due is not in the log, so a replay cannot say why the command ran.

Effect 4 has durable timers (`effect/workflow`: `DurableClock.sleep`, `DurableDeferred`; `effect/cluster`: `DeliverAt`, `ClusterCron`), all marked
unstable. The question is whether to use them or to keep deadlines in the log.

## Decision (proposed)

**A deadline is an event, appended by `decide` in the same append as the decision that sets it. Firing it is an event too. A deadlines processor keeps
the deadlines that are set and not fired in a table, and when one is due runs its command through the executor, with the deadline as its cause.**

1. **Setting one.** `deadline(Command, input, { at })` (`@crablet/commands/Domain`) builds a framework event, `crablet.DeadlineScheduled
   { command, input, dueAt }`, that `decide` returns with the rest:
   `emit(CourseDefined(c), deadline(CloseEnrolment, { courseId: c.courseId }, { at: addDays(now, 7) }))`. The input is typed from the command's schema
   (`RawInput`, ADR-0038) and stored encoded. It is part of the append, so a deadline exists exactly when the decision that set it does.
2. **Its tags are the framework's.** `deadline_command=<command name>` only. It does not carry the entity's tag, so it is not in any application model's
   boundary and the change-impact report (ADR-0017) does not ask every model bound by that tag to account for it.
3. **No cancel.** A deadline always fires. Its command's `decide` reads the model and answers `noop` when the deadline no longer matters (the course was
   confirmed). The model is already where that is known, and a cancel would be a second place to keep it consistent. To move a deadline, set a new one
   and record in an application event the decision emits with it (an `EnrolmentClosesAt { at }` the model folds) which one is current; the command of the
   old one compares and answers `noop`.
4. **Firing is recorded.** After the command has run, whatever it answered (an append, `noop`, a domain error), the processor appends
   `crablet.DeadlineFired { deadlinePosition, outcome }`, caused by the deadline. So which deadlines are pending is a fact of the log: those scheduled and
   not fired.
5. **The table can be rebuilt from the log.** `crablet_deadlines (deadline_position, command, input, due_at)` is a projection of `DeadlineScheduled`
   (insert) and `DeadlineFired` (delete), its batch committed with its cursor (ADR-0023). Rebuilt from the log, it holds exactly the pending deadlines;
   nothing fired comes back.
6. **Firing runs on the clock, in a loop of its own.** The event poller reads new events; firing reads the table by time. So the processor has two
   loops: the projection (an ordinary poller over the two event types) and the firing loop, which reads the due rows (oldest first, a batch at a time),
   decodes each input with its command's schema, runs the command with `causationId` = the deadline's position, then appends `DeadlineFired`. It sleeps
   until the earliest due row or its polling interval, whichever is sooner, and a new deadline due sooner wakes it. A crash between the command and
   `DeadlineFired` fires it again: the command's `idempotentBy` answers "already done", and the backstop does if that misses (ADR-0035).
7. **One clock: the application's.** `dueAt` is written from `decide`'s `now`, and the firing loop compares it with the processor's `Clock`, the
   same application clock the period turn reads (ADR-0025). A pod whose clock is behind fires late, never early by more than the skew between pods.
8. **What runs it.** The commands a deadline can name are given to the processor, as automations are
   (`startDeadlinesProcessor({ commands: [CloseEnrolment] })`; no discovery, ADR-0008). Each must declare `idempotentBy`, refused when the processor is
   built, as `defineAutomation` does. A due deadline whose command is not given, or whose input no longer decodes, stops the firing loop with a typed
   failure, never skipped (ADR-0017).
9. **Where it runs.** In the `automations` role and package: it fires commands through the same executor, causation and backstop as automations. It
   has a `ProcessorManagementService`, so the processors admin API lists it, pauses and resumes it once the application gives it as a source
   (ADR-0020); and a leader lock of its own, so it fails over independently of the automations and can run in another deployment.
10. **Precision.** A deadline fires at or after `dueAt`, never before; with the processor running, at most one polling interval late. It is for business
    time (minutes, days), not timers in seconds. A deadline due while the processor was down fires, once, when it comes back.

## Consequences

- The Aggregator gets its expiry, and the guide's "what is missing" section becomes a step: `DefineCourse` sets a deadline, and `CloseEnrolment`
  decides from the course's readiness model what to do with a course that is not complete.
- Why a command ran is in the log: its causation is a `DeadlineScheduled`, which says which decision set it and for when, and a `DeadlineFired` says
  how it ended.
- Framework events in the application's log, the first: `crablet.DeadlineScheduled` and `crablet.DeadlineFired`. The `crablet.` prefix, which no event uses yet, keeps them from colliding with an application's names by accident. An app's
  own processors select by event type, so they do not see them unless they ask for them.
- A migration for the table and its index on `due_at`, and one more leader lock key, a constant in `@crablet/eventstore/Leader` like the others.
- **A deadline's input is stored data.** It evolves as an event payload does: a command's input schema that changes must still read the inputs of the
  deadlines already set, and the event fixtures of an app that sets deadlines should hold one per command (ADR-0017).
- **A deadline names its command by name.** Renaming or removing a command that has pending deadlines makes them stop the firing loop when they are due,
  loudly. The same is true of an HTTP path today, but this one is in stored data: a command with pending deadlines keeps its name, or its deadlines are
  fired by the old name before it goes.
- New machinery, not a reuse: the firing loop is a second kind of loop beside the poller (time instead of new events), with its own wake-up.
- Testing without a database would need a scenario helper that fires what is due at a given instant. `Scenario.at(date)` exists (a fixed clock); a
  `fireDue()` beside it would be added with this.

## Alternatives considered

- **Effect's workflow engine (`DurableClock.sleep` in a `Workflow`).** A durable sleep is the right primitive, but the workflow keeps its state in its own
  engine storage, so the deadline would live outside the log: two sources of truth, a replay that cannot see it, and the "Aggregator with its own store"
  the log was meant to replace. The workflow and cluster modules are also marked unstable, and the project pins Effect (ADR-0009).
- **Effect's cluster (`DeliverAt` messages, `ClusterCron`).** The same objection to the store (`SqlMessageStorage`), and it brings sharding and runners
  a crablet deployment does not otherwise need. A plain `Schedule` can still drive the firing loop's tick; the deadlines stay events.
- **A sweep written by the application (today).** Stays possible and is what the guide describes until this is built. Rejected as the answer because each
  app re-writes the query, the idempotency and the leadership, and the due time is not in the log.
- **A deadlines table written by `decide` directly, not an event.** It would need its own write in the command's transaction and would not survive a
  rebuild from the log; an event gets both.
- **Deleting a fired row without an event.** The first draft of this record did. A rebuild would bring every fired deadline back, and a command that had
  answered `noop` leaves nothing for the backstop to find, so it would decide again on a model that has moved on.
- **Tagging the deadline with the entity**, so a model could fold it. Every model bound by that tag would then have to account for it in the
  change-impact report, in every app, and `.on(DeadlineScheduled)` would see the entity's deadlines for every command. An application event the decision
  emits beside the deadline (decision 3) says the same thing without either cost.
- **A cancel operation.** Rejected for now (decision 3): the model already knows whether the deadline still matters. Revisit if many deadlines are set
  and almost all become moot, since each still costs one command run and one `DeadlineFired`.

## Decided while proposing (2026-10-24)

- **The clock: the application's** (decision 7), for writing and firing, as the period turn does, so a scenario test fixes it with `at(date)`. Not the
  database's (`dueAt` as a duration the append adds to `now()`): one clock for all pods, but an absolute time ("Friday 17:00") would still come from the
  application, and a test could not fix it.
- **Framework events are prefixed `crablet.`** Not plain names, which an application's own event could take.
- **The processor has a lock of its own** (decision 9). Not the automations' lock: sharing it would save one constant and make the two fail over together.

## Open questions

- How many due deadlines one batch runs, and whether one slow command holds back the rest (the outbox's per-publisher timeout, ADR-0036, is the
  precedent).
- Whether `DeadlineFired` should record the command's result marker, so a reader can go from the deadline to what it wrote.
