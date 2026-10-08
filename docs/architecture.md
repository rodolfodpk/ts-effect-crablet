# Architecture

How the pieces fit, and how the core features work, in diagrams. Every diagram is a map of code that exists: the names are real packages, modules and tables. For the reasons behind
each design, follow the links to the [decision records](./adr/README.md); for the words, see the [glossary](./glossary.md).

The two example applications also have [C4 models](./c4-examples.md) (context, containers, components).

Contents: [the whole system](#the-whole-system) · [a command, from request to append](#a-command-from-request-to-append) · [two commands that conflict](#two-commands-that-conflict) ·
[from event to view](#from-event-to-view) · [a read that includes your write](#a-read-that-includes-your-write) · [one lock per module, one leader per lock](#one-lock-per-module-one-leader-per-lock) ·
[changing an event](#changing-an-event) · [what is in the database](#what-is-in-the-database)

## The whole system

One PostgreSQL database holds one event log. Everything that writes goes through `eventstore`'s conditional append; everything that reacts reads the same log through a poller.

```mermaid
flowchart TB
  client["Client: browser, service, curl"]

  subgraph app["Your application"]
    direction TB
    http["commands-http<br/>POST /api/commands/name"]
    vhttp["views-http<br/>reads that wait for a marker"]
    phttp["processors-http<br/>list, pause, resume, reset<br/>(behind your authorization)"]
    cmd["commands<br/>defineEvent, defineModel, defineCommand<br/>CommandExecutor"]
    subgraph vm["views module: its own lock"]
      pv["event-poller<br/>cursors, fence"] --> views["views<br/>projectors into your tables"]
    end
    subgraph am["automations module: its own lock"]
      pa["event-poller<br/>cursors, fence"] --> auto["automations<br/>event in, command out"]
    end
    subgraph om["outbox module: its own lock"]
      po["event-poller<br/>cursors, fence"] --> outbox["outbox<br/>publishers per topic"]
    end
  end

  subgraph store["eventstore"]
    es["EventStore<br/>conditional append, tag queries"]
    listen["Listen and Leader<br/>NOTIFY wake-ups,<br/>one advisory lock per module"]
  end

  pg[("PostgreSQL<br/>crablet_events and friends")]
  ext["External systems<br/>brokers, webhooks"]
  metrics["metrics-otel<br/>crablet.* metrics"]

  client --> http
  client --> vhttp
  client --> phttp
  phttp --> pv
  phttp --> pa
  phttp --> po
  http --> cmd
  cmd --> es
  es --> pg
  vhttp --> views
  views -. reads view tables .-> pg

  pg -. new events .-> pv
  pg -. new events .-> pa
  pg -. new events .-> po
  auto --> cmd
  outbox --> ext
  pv --> listen
  pa --> listen
  po --> listen
  listen --> pg

  metrics -. recorded by every package .- app
```

Reading it: a **write** goes client → `commands-http` → `commands` → `eventstore` → Postgres. A **reaction** starts at a module's poller (the views, the automations and the outbox each have their own, and their own leader lock), which reads new events and hands them to that module's processors; an automation turns an event back into a command. A **read** of a view goes through `views-http`, which can wait until the view has caught up. An operator can list the processors and pause, resume or reset one through `processors-http`. Each package
is described in [the reference](./reference.md#packages).

## A command, from request to append

The executor is the only place a decision becomes an append. `decide` is pure; everything that touches the database is around it, inside one transaction.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant H as commands-http
  participant X as CommandExecutor
  participant M as Model
  participant S as EventStore
  participant P as PostgreSQL

  C->>H: POST /api/commands/subscribe
  H->>X: run(Subscribe, input)
  X->>X: validate input against the Schema
  Note over X,P: one transaction per attempt
  X->>M: load the model for this input
  M->>S: read the events in the boundary
  S->>P: tag query, newest position
  P-->>S: events and their position
  S-->>M: events
  M-->>X: state and the boundary cursor
  X->>X: decide(state, input) returns emit, fail or noop
  alt emit
    X->>S: append events if nothing newer in the boundary
    S->>P: append_events_if
    P-->>S: positions, or the condition failed
  else fail
    X-->>H: a domain error
  else noop
    X-->>H: idempotent success
  end
  S-->>X: appended with a marker
  X-->>H: result
  H-->>C: 201 with a marker, or 400, 404, 409 as problem+json
```

The idempotency check runs inside the append before the concurrency check, so a repeat of an already-done operation is an idempotent success, never a spurious conflict. The
command is audited when auditing is on. See [ADR-0003](./adr/0003-non-commutative-append-concurrency-protection.md) and [ADR-0010](./adr/0010-declarative-command-api.md).

## Two commands that conflict

This is the idea of dynamic consistency boundaries. Two bookings of the same seat share a boundary, so one of them must lose; a booking of a different seat shares nothing with
either and never waits.

```mermaid
sequenceDiagram
  autonumber
  participant A as Command A: book 12A for Ann
  participant B as Command B: book 12A for Bob
  participant L as Event log
  participant D as Command D: book 99Z for Dan

  A->>L: read boundary of seat 12A
  L-->>A: SeatAdded at position 10
  B->>L: read boundary of seat 12A
  L-->>B: SeatAdded at position 10
  A->>L: append SeatBooked if nothing newer than 10
  L-->>A: ok, position 11
  B->>L: append SeatBooked if nothing newer than 10
  L-->>B: refused, SeatBooked at 11 is newer
  Note over B: Conflict, so the whole command re-runs
  B->>L: read boundary of seat 12A
  L-->>B: SeatAdded 10, SeatBooked 11
  B->>B: decide fails with SeatTaken
  D->>L: append SeatBooked for 99Z if nothing newer in its own boundary
  L-->>D: ok, unaffected by A and B
```

The retry is safe because `decide` is pure and the first attempt's transaction rolled back. `retries` defaults to 3; when they run out, the last `Conflict` is reported.
Commands that are safe to run in parallel with themselves (deposits) declare `concurrent({ guard })` and only the guard events can conflict. A model over several entities (`all(...)`) uses the
union of their boundaries, and its cursor is the earliest of the members' read horizons, which never misses a conflict. Walkthrough: [DCB guide](./dcb-guide.md).

## From event to view

A poller turns the log into a read model. Delivery is at-least-once, so the projector must be idempotent, and the cursor makes sure nothing is skipped.

```mermaid
sequenceDiagram
  autonumber
  participant W as A writer
  participant P as PostgreSQL
  participant Q as event-poller, the leader
  participant J as Projector
  participant V as View table

  W->>P: append events, commit
  P-->>Q: NOTIFY crablet_events, only a wake-up
  Q->>P: read the cursor of this processor
  Q->>P: fetch events after the cursor, matching types and tags
  P-->>Q: a batch
  Q->>Q: fence, am I still the leader
  Q->>J: handle(batch)
  J->>V: apply the batch in one transaction
  Q->>Q: fence again
  Q->>P: move the cursor, forward only
  Q->>P: NOTIFY crablet_view_progress
```

The wake-up is only a hint: if it is lost, the next poll finds the events anyway (the poll interval is the fallback). The cursor is a `(transaction_id, position)` pair rather than a bare position,
because a transaction with a lower id can commit after one with a higher position; a bare position would skip its events for ever ([ADR-0012](./adr/0012-transaction-position-cursors.md)).
The same loop drives the outbox (`publishBatch`) and automations (`decide`, then run a command).

## A read that includes your write

Views update after the command returned, so a client that writes and then reads could see old data. The command returns a **marker**; the read carries it and waits.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as commands-http and views-http
  participant H as ViewProgressHub
  participant V as View table

  C->>API: POST command
  API-->>C: 201 with marker M
  C->>API: GET /api/courses?consistentWith=M
  API->>H: wait until the views have processed M
  Note over H: one LISTEN per process,<br/>fans pings out in memory
  H-->>API: view progress passed M
  API->>V: SELECT
  V-->>API: rows including the write
  API-->>C: 200

  alt the views do not catch up in time
    API-->>C: 503 with Retry-After in the default strict mode
  end
```

A read with no marker waits for the head of the log. The modes are `strict` (right or a `503`, the default), `bounded` (returns the data marked stale after a timeout) and `eventual` (does not wait).
A client that did not write learns that something changed from a **ping** over server-sent events and reads again. See [ADR-0015](./adr/0015-read-consistency-by-marker.md),
[ADR-0014](./adr/0014-live-updates-by-ping.md) and [ADR-0016](./adr/0016-one-listen-per-process-for-view-progress.md).

## One lock per module, one leader per lock

Every instance of the application starts the same processors. A PostgreSQL advisory lock decides which instance runs them, and **the lock is per module, not per processor**: there is one lock for
the views, one for the automations and one for the outbox publishers (`VIEWS_LOCK_KEY`, `AUTOMATIONS_LOCK_KEY`, `OUTBOX_LOCK_KEY` in `eventstore`'s `Leader.ts`). The instance that holds a
module's lock runs **all** of that module's processors (every view, every automation, every publisher); the others wait and retry. The three locks are independent, so a different instance may lead each
module, though the first instance to start usually leads all three. The diagram shows one possible split, not the usual one.

```mermaid
flowchart LR
  subgraph pg["PostgreSQL: three advisory locks, each held by one session"]
    lv(("views lock"))
    la(("automations lock"))
    lo(("outbox lock"))
  end

  subgraph a["Instance A (leader of views and outbox)"]
    av["views module<br/>all 4 view processors run here"]
    aa["automations module<br/>waits"]
    ao["outbox module<br/>every publisher runs here"]
  end

  subgraph b["Instance B (leader of automations)"]
    bv["views module<br/>waits"]
    ba["automations module<br/>every automation runs here"]
    bo["outbox module<br/>waits"]
  end

  lv == "held by A" ==> av
  lv -. "B retries every 5 s" .-> bv
  la == "held by B" ==> ba
  la -. "A retries every 5 s" .-> aa
  lo == "held by A" ==> ao
  lo -. "B retries every 5 s" .-> bo
```

Two consequences. **A processor's status is per processor** (you pause one view, not the module), but **who runs it is per module**: pausing a view does not move it to another instance, and a
dead instance takes all of its modules' processors with it until another instance takes the locks. And **leadership is observed per module**: the `crablet.poller.leadership` gauge carries the lock's number
(`lock_key`) and the instance, not a processor id.

What happens when the leader dies, observed by killing the process (`kill -9`) in a two-instance run ([the crash test](./plans/dashboard.md)):

```mermaid
sequenceDiagram
  autonumber
  participant A as Instance A (leader)
  participant PG as PostgreSQL (advisory locks)
  participant B as Instance B (follower)
  participant M as Metrics backend

  A->>PG: holds the three locks, heartbeat
  A->>M: leadership = 1 for each lock, re-sent every export interval
  B->>PG: tries each lock every 5 s (fails)
  Note over A: kill -9
  PG-->>PG: A's session ends, its locks are released
  B->>PG: next retry takes each lock
  B->>M: leadership = 1 for each lock (first within about 5 s, all three within 10 s)
  Note over M: A's series stays at 1 but is no longer re-sent.<br/>It is dropped about five minutes later.
```

The loop below is one processor's tick, inside the module that holds the lock.

```mermaid
flowchart TD
  start(["tick"]) --> lead{"Does my instance hold<br/>this module's lock?"}
  lead -- no --> wait["Sleep, or wake on a NOTIFY.<br/>A separate retry loop keeps trying<br/>to take the advisory lock"]
  wait --> start
  lead -- yes --> status{"Status paused<br/>or failed?"}
  status -- yes --> idle["Do nothing this tick"]
  status -- no --> cur["Read the cursor"]
  cur --> fetch["Fetch the next batch after the cursor"]
  fetch --> any{"Any events?"}
  any -- no --> backoff["Back off, then sleep or wake on NOTIFY"]
  any -- yes --> f1["Fence: still the leader?"]
  f1 -- no --> stop["Stop: leadership lost"]
  f1 -- yes --> handle["Run the handler"]
  handle -- fails --> err["Record the error against the processor"]
  handle -- ok --> f2["Fence again"]
  f2 -- no --> stop
  f2 -- yes --> move["Move the cursor forward only"]
  move --> start
```

The heartbeat checks `pg_locks` for this session rather than just pinging the connection, so a leader whose lock is gone (a dead session) stops instead of handling events the new leader also handles.
The cursor update is guarded in SQL so it cannot move backwards. A graceful stop releases the lock and announces it with a wildcard NOTIFY, so another instance takes over immediately; after a crash, the
others notice on their next retry (5 s by default). See [ADR-0006](./adr/0006-leader-election-via-sql-reserve.md), [ADR-0007](./adr/0007-event-poller-fiber-model.md) and the
[reliability report](./plans/reliability-and-scale-diagnostic.md).

## Changing an event

Events are stored for ever, so a definition change must keep old events readable. **Deciding that is the programmer's job, at design time.** The framework's part at run time is only to detect an
event it cannot read and refuse it; it never converts or repairs one.

```mermaid
flowchart TD
  subgraph design["Design time: your decisions and your checks"]
    want(["I change an event definition"]) --> kind{"Can the new definition still decode<br/>every shape already stored?"}
    kind -- "yes: a field with a default,<br/>or an optional field" --> compat["Keep the name"]
    kind -- "no: rename, retype, remove,<br/>or the meaning changed" --> newev["A new event name. The old definition stays,<br/>and models and readers handle both"]
    compat --> checks
    newev --> checks
    checks["Run the checks: fixtures and the change-impact report<br/>(unit tests), verify-events on production-like data"] --> ship(["Deploy"])
  end

  subgraph runtime["Run time: automatic, but only detects and refuses"]
    read["Every read of a stored event<br/>goes through its definition"] --> ok{"Does it decode?"}
    ok -- yes --> use["Used by the model, projector or automation"]
    ok -- no --> err["Typed EventDecodingError, never skipped,<br/>never carrying the payload.<br/>A command fails; a view or automation is recorded as failing"]
  end

  ship --> read
  err -.-> fix["You repair it: revert or loosen the definition,<br/>or append an event that corrects the facts.<br/>Nothing edits the stored event"]
```

Tags are additive-only for the same reason: a model's boundary is found by tags. Who does what, in a table: [Evolving events](./evolving-events.md#who-does-what-you-decide-the-framework-detects);
decision: [ADR-0017](./adr/0017-event-evolution-by-compatibility.md).

## What is in the database

The framework owns these tables (the schema in [`@crablet/db-migrations`](../packages/db-migrations/README.md)); your views live beside them.

```mermaid
erDiagram
  crablet_events {
    bigserial position PK
    text type
    text_array tags "GIN indexed"
    jsonb data
    xid8 transaction_id
    uuid correlation_id
    bigint causation_id
  }
  crablet_event_tag_keys {
    text key
    bigint position
  }
  crablet_commands {
    uuid command_id PK
    xid8 transaction_id "the same transaction as its events"
    text type
    jsonb data
    jsonb metadata
  }
  crablet_view_progress {
    text view_name PK
    text status
    bigint last_position "with the transaction id: the cursor"
    int error_count
    text last_error
  }
  crablet_automation_progress {
    text automation_name "cursor and status per automation"
  }
  crablet_outbox_topic_progress {
    text topic "cursor and status per topic"
  }
  your_view_tables {
    text yours "written by your projectors"
  }

  crablet_events ||--o{ crablet_event_tag_keys : "one row per tag key, so pollers can filter by key"
  crablet_commands ||--o{ crablet_events : "appended in the same transaction, when auditing is on"
  crablet_view_progress }o--|| crablet_events : "cursor points into the log"
  crablet_automation_progress }o--|| crablet_events : "cursor points into the log"
  crablet_outbox_topic_progress }o--|| crablet_events : "cursor points into the log"
  your_view_tables }o--|| crablet_view_progress : "kept up to date by"
```

The event row carries its tags as an array (for the append condition and tag queries); `crablet_event_tag_keys` holds only the tag **keys**, one row per event and key, so that a poller's "has any of these keys" filter does
not scan the log. There is no foreign key between them (migration V11). The tables are sized and monitored as described in [Monitor it](./guides/monitor-it.md) and
[ADR-0019](./adr/0019-storage-visibility-and-the-tag-table.md).
