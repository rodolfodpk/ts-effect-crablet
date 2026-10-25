# ADR-0043: A deadline is an event in the log, and a processor runs its command when it is due

## Status

**Proposed** (2026-10-24; revised the same day to fire deadlines on the event-poller engine). Nothing built, and nothing needs it yet: it is to be built
when an application does. It answers the gap the
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

**A deadline is an event, appended by `decide` in the same append as the decision that sets it. Firing it is an event too. The append that stores a
deadline also writes it into a table of pending deadlines, and a processor of the event-poller engine, whose fetcher reads that table by time, runs
each due deadline's command through the executor, with the deadline as its cause.**

1. **Setting one.** `deadline(Command, input, { at })` (`@crablet/commands/Domain`) builds a framework event, `crablet.DeadlineScheduled
   { command, input, dueAt }`, that `decide` returns with the rest:

   ```ts
   const closesAt = DateTime.add(now, { days: 7 });
   emit(
     CourseDefined(c),
     EnrolmentClosesAt({ courseId: c.courseId, at: closesAt }),
     deadline(CloseEnrolment, { courseId: c.courseId, closesAt }, { at: closesAt })
   );
   ```

   The input is typed from the command's input schema and stored encoded by it, as an event's payload is (ADR-0044); `dueAt` is an `Instant`. It is
   part of the append, so a deadline exists exactly when the decision that set it does.
2. **It carries no tags.** An append takes an exclusive lock on each (event type, tag) pair of its own events (migration V5). A shared tag such as
   `deadline_command=<name>` would make every append that sets a deadline for that command wait on one lock, across all entities. An event with no tags
   takes only the shared type and global locks, so setting deadlines serializes nothing. Nothing reads deadlines by tag: the table (decision 5) is
   their index. With no entity tag, a deadline is in no application model's boundary, and the change-impact report (ADR-0017) asks no model to account
   for it.
3. **No cancel.** A deadline always fires. Its command's `decide` reads the model and answers `noop` when the deadline no longer matters (the course was
   confirmed). The model is already where that is known, and a cancel would be a second place to keep it consistent. To move a deadline, set a new one
   and record which one is current in an application event the decision emits with it (`EnrolmentClosesAt`, which the model folds). The due time goes
   in the command's input (`closesAt`), so the command of a superseded deadline sees that its time is not the current one and answers `noop`.
4. **Firing is recorded.** After the command has run, the processor appends `crablet.DeadlineFired { deadlinePosition, outcome, reason }`, caused by the
   deadline, with no tags (decision 2's reason does not apply to a single writer, but nothing reads them by tag either). So which deadlines are pending
   is a fact of the log: those scheduled and not fired.
5. **The table is an index of the log, written by the append.** It holds the position and the due time, nothing else; the command, the input and the
   correlation id stay in the event and are read by a join on its primary key, so nothing is copied that could disagree with the log:

   ```sql
   CREATE TABLE crablet_deadlines
   (
       deadline_position BIGINT                   NOT NULL PRIMARY KEY,  -- the DeadlineScheduled event's position
       due_at            TIMESTAMP WITH TIME ZONE NOT NULL
   );
   CREATE INDEX idx_crablet_deadlines_due ON crablet_deadlines (due_at, deadline_position);
   ```

   The append function inserts a row for each `crablet.DeadlineScheduled` it stores, in the same statement (and the in-memory store does the same), so a
   deadline is pending from the instant its decision commits, whoever appended it, and no projection lags behind it. The firing deletes the row
   (decision 6). The table can be rebuilt from the log in one statement:

   ```sql
   TRUNCATE crablet_deadlines;
   INSERT INTO crablet_deadlines (deadline_position, due_at)
   SELECT s.position, (s.data ->> 'dueAt')::timestamptz
   FROM crablet_events s
   WHERE s.type = 'crablet.DeadlineScheduled'
     AND NOT EXISTS (SELECT 1 FROM crablet_events f WHERE f.type = 'crablet.DeadlineFired' AND f.causation_id = s.position);
   ```

   Querying the log directly instead of keeping a table would scan every deadline ever set, by a time inside the payload that cannot be indexed (a
   text-to-`timestamptz` cast is not immutable).
6. **Firing is a processor of the event-poller engine.** The engine already runs one leader per module, checks before each batch that it still holds
   the lock, polls, counts errors, marks a processor `FAILED` and gives the admin API a `ProcessorManagementService`. Firing deadlines needs all of it;
   what differs is only which events are ready. So the deadlines module is `makeEventProcessor` with:

   - **a fetcher by time**: it returns the `DeadlineScheduled` events whose row is due (`WHERE due_at <= $now ORDER BY due_at, deadline_position LIMIT
     $batchSize`, joined to the event), and ignores the cursor;
   - **a handler that fires one deadline at a time**: it decodes the input with its command's schema and runs the command, in its own transaction with
     its retries, with `causationId` = the deadline's position; then, in one transaction, it appends `DeadlineFired` and deletes the row. A failure
     part-way through a batch is a `HandledPrefix` (ADR-0036): the deadlines already fired stay fired;
   - **a progress tracker whose cursor is inert**: the progress is the rows deleted, not a position in the log. It keeps the status, the error count
     and the registration, in a progress row of its own;
   - **no wake-up stream and no backoff** (`backoffEnabled: false`): a new event makes nothing due, time does, so the processor polls at
     `pollingIntervalMs`. An empty poll is one index lookup.

   The row is deleted in the same transaction as `DeadlineFired`, so a deadline whose firing is recorded is never fetched again. The two steps cannot be
   one transaction, because a command must run in a transaction that has not written (ADR-0033). A crash between them fires the deadline again: a
   command that appended is answered "already done" by its `idempotentBy`, or by the backstop if that misses (ADR-0035); one that answered `noop`
   decides again, which appends nothing.
7. **What a firing can end in.**
   - The command appends, or answers `noop`: `outcome` `appended` or `noop`, with the reason.
   - The command fails with a domain error: that is a decision, not a fault. `outcome` `failed`, the error's tag as the reason; the row is deleted and
     the processor moves on.
   - An infrastructure fault (the database, a `Conflict` that ran out of retries), a command that is not registered, or an input that no longer decodes:
     the batch fails, the engine retries it and, after `maxErrors`, marks the processor `FAILED`, as it does a view; the admin API's `reset` restarts
     it. Never skipped (ADR-0017).

   Deadlines fire in due order, so one that stops the processor holds back the ones after it, as a failing event holds back a view.
8. **One clock: the application's.** `dueAt` is written from `decide`'s `now`, and the fetcher compares it with the processor's `Clock`, the same
   application clock the period turn reads (ADR-0025).
9. **What runs it.** The commands a deadline can name are given to the processor, as automations are
   (`startDeadlinesProcessor({ commands: [CloseEnrolment] })`; no discovery, ADR-0008). Building the processor refuses a command that declares no
   `idempotentBy`, as `defineAutomation` does, and one whose input schema has a field marked `personal(...)`: the input is stored inside a framework
   event, where the mark is lost, so the event log API would not mask it and nothing could erase it. A deadline's input carries ids, not personal data.
10. **Where it runs.** In the `automations` role and package: it fires commands through the same executor, causation and backstop as automations. It
    has a leader lock of its own (`DEADLINES_LOCK_KEY`), so it fails over independently of the automations. Its admin source describes it by what
    matters for deadlines: how many are due, and how long ago the oldest one fell due.
11. **Precision.** A deadline fires at or after `dueAt` by the firing pod's clock. Relative to the pod that set it, it can be early or late by the skew
    between the two clocks. With the processor running it is late by up to one polling interval, plus the backlog of deadlines due before it. It is for
    business time (minutes, days), not timers in seconds. A deadline due while the processor was down fires, once, when it comes back.

## Consequences

- The Aggregator gets its expiry, and the guide's "what is missing" section becomes a step: `DefineCourse` sets a deadline, and `CloseEnrolment`
  decides from the course's readiness model what to do with a course that is not complete.
- Why a command ran is in the log: its causation is a `DeadlineScheduled`, which says which decision set it and for when, and a `DeadlineFired` says
  how it ended.
- Framework events in the application's log, the first: `crablet.DeadlineScheduled` and `crablet.DeadlineFired`. The `crablet.` prefix, which no event
  uses yet, keeps them from colliding with an application's names by accident. A view or automation selects the event types of its handlers, so it does
  not see them; a selection with no event types is unrestricted (`EventSelection`) and does.
- Two events per deadline, kept with the rest of the log.
- A migration: the table and its index, the append function's insert, and the processor's progress row; and one more leader lock key, a constant in
  `@crablet/eventstore/Leader` like the others.
- **A deadline's input is stored data.** It evolves as an event payload does: a command's input schema that changes must still read the inputs of the
  deadlines already set, and the event fixtures of an app that sets deadlines should hold one per command (ADR-0017).
- **A deadline names its command by name.** Renaming or removing a command that has pending deadlines makes the processor `FAILED` when they are due,
  loudly. The same is true of an HTTP path today, but this one is in stored data: a command with pending deadlines keeps its name, or its deadlines are
  fired by the old name before it goes.
- Little new machinery. Leadership, polling, error counting, `FAILED`, pause and resume come from the event-poller engine. What is new is a fetcher
  that reads by time, the handler, a progress tracker whose cursor is inert, and the admin description.
- Testing without a database would need a scenario helper that fires what is due at a given instant. `Scenario.at(now)` exists (a fixed clock, a `DateTime.Utc`); a
  `fireDue()` beside it would be added with this.

## Alternatives considered

- **Effect's workflow engine (`DurableClock.sleep` in a `Workflow`).** A durable sleep is the right primitive, but the workflow keeps its state in its own
  engine storage, so the deadline would live outside the log: two sources of truth, a replay that cannot see it, and the "Aggregator with its own store"
  the log was meant to replace. The workflow and cluster modules are also marked unstable, and the project pins Effect (ADR-0009).
- **Effect's cluster (`DeliverAt` messages, `ClusterCron`).** The same objection to the store (`SqlMessageStorage`), and it brings sharding and runners
  a crablet deployment does not otherwise need. The event-poller engine's polling is the tick here; the deadlines stay events.
- **A sweep written by the application (today).** Stays possible and is what the guide describes until this is built. Rejected as the answer because each
  app re-writes the query, the idempotency and the leadership, and the due time is not in the log.
- **A deadlines table written by `decide`, not an event.** An application's own write in the command's transaction, with nothing in the log to rebuild
  it from. Here the framework writes the row from the event, in the append that stores it, and the log rebuilds it (decision 5).
- **A firing loop of its own (the first drafts).** It would have rebuilt the leadership, the zombie check, the error counting and the admin operations
  the event-poller engine already has, with its own wake-up to keep correct.
- **A projection that inserts the rows (the first drafts).** A second processor, and a window in which a deadline that is stored is not yet in the table.
- **Deleting a fired row without an event.** The first draft of this record did. A rebuild would bring every fired deadline back, and a command that had
  answered `noop` leaves nothing for the backstop to find, so it would decide again on a model that has moved on.
- **Leaving the delete to the projection.** The second draft did. Until the projection caught up, the row stayed due and was fired again, with a second
  `DeadlineFired` in the log.
- **Copying the command and input into the table.** A second copy of what the event holds, which could disagree with it; a join on the primary key costs
  less than the copy.
- **Tagging the deadline**, with the entity so a model could fold it, or with its command (the second draft). With the entity, every model bound by that
  tag would have to account for it in the change-impact report, in every app, and `.on(DeadlineScheduled)` would see the entity's deadlines for every
  command; with the command, every append that sets one would wait on one lock. An application event the decision emits beside the deadline
  (decision 3) says what a model needs without either cost.
- **A cancel operation.** Rejected for now (decision 3): the model already knows whether the deadline still matters. Revisit if many deadlines are set
  and almost all become moot, since each still costs one command run and one `DeadlineFired`.
- **A `deadlines` role of its own.** Not needed: the processor has its own lock, and the automations role already runs the executor it fires through.

## Decided while proposing (2026-10-24)

- **The clock: the application's** (decision 8), for writing and firing, as the period turn does, so a scenario test fixes it with `at(now)`. Not the
  database's (`dueAt` as a duration the append adds to `now()`): one clock for all pods, but an absolute time ("Friday 17:00") would still come from the
  application, and a test could not fix it.
- **Framework events are prefixed `crablet.`** Not plain names, which an application's own event could take.
- **The processor has a lock of its own** (decision 10). Not the automations' lock: sharing it would save one constant and make the two fail over together.
- **Firing is a processor of the event-poller engine** (decision 6), with a fetcher that reads by time, and **the append writes the table** (decision 5):
  one processor, on the infrastructure that already keeps one pod doing the work.

## Open questions

- How many due deadlines one batch runs, and whether one slow command holds back the rest (the outbox's per-publisher timeout, ADR-0036, is the
  precedent).
- Whether `DeadlineFired` should record the command's result marker, so a reader can go from the deadline to what it wrote.
