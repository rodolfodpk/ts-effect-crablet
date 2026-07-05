# ADR-0007: Event-poller fiber model — one daemon fiber per processorId, one shared leader-retry fiber

## Status

Accepted (Phase 2)

## Context

Java's poller schedules a one-shot, self-resubmitting task per processorId, guarded by an
"already running" check to prevent overlapping ticks for the same processor, plus a two-tier
leader-retry timing scheme (a 30s shared task and a 5s per-tick follower cooldown). Effect's fiber
model offers a more direct alternative: a single, persistent fiber per processorId that loops
forever, and a single shared fiber that retries leader acquisition — but this has to be built
correctly with respect to Effect's structured concurrency, which is not automatic.

**The one real bug this phase produced.** `EventProcessor.start()` forks three long-lived
background fibers (LISTEN/NOTIFY dispatcher, leader-retry loop, one loop per processorId) and
returns immediately — `start()`'s own effect completes right after the last fork call. This passed
cleanly against Bun unit tests, where `start()` is called from inside one long `Effect.gen`
program that keeps its own fiber alive all the way through `stop()` — the bug was invisible there.
It only showed up in the Postgres integration tests, where `start()` is (correctly, realistically)
its own separate `runtime.runPromise(startProcessor(...))` call returning a handle to the caller.
Symptom: the forked fibers never did anything — no fetch, no handler call, not even the first line
of the loop body — for the entire test run, with no errors or logs. Root cause: plain
`Effect.fork` ties a child fiber's lifetime to its parent under Effect's structured-concurrency
guarantee. As soon as `start()`'s own fiber *completes* (not just if interrupted — completing
normally is enough), Effect interrupts every fiber that was `fork`ed from it before they get a
chance to run.

## Decision

- One persistent daemon fiber per processorId replaces Java's one-shot self-resubmitting scheduled
  task — this also eliminates the "already running" guard by construction, since a single
  dedicated fiber can't run two overlapping ticks for the same processorId.
- Leader-retry collapses Java's two-tier timing into one shared retry fiber per module, since only
  one fiber ever attempts `pg_try_advisory_lock` here.
- `acquireLeader` / `wakeupStream` are injected into the engine as already-built `Effect`/`Stream`
  values rather than raw `sql`/`pg` handles plus lockKey/channel parameters — this decouples the
  engine from concrete Postgres wiring.
- Every long-lived background fiber in `EventProcessor.ts` (dispatcher, leader-retry, per-processor
  loops) is created with `Effect.forkDaemon`, never plain `Effect.fork`. `forkDaemon` detaches a
  fiber from parent-child supervision entirely; its lifetime is managed independently until
  something explicit (here, `stop()`'s `Fiber.interruptAll`) interrupts it. This is the fix, and is
  the single most consequential bug found in this phase.

## Consequences

- Any future background-fiber addition to this engine must use `forkDaemon`, not `fork` — this is
  easy to get wrong silently, since it only manifests when the forking call's own fiber is
  short-lived (i.e. in realistic, non-test-harness usage).
- Any test exercising a `start()`-shaped API (forks fibers, returns immediately) must call it as a
  separate, short `runPromise`, not inline inside one giant long-lived test program — otherwise a
  `fork`-vs-`forkDaemon` mistake will not be caught, because the bug is specifically about what
  happens *after* the forking call returns.
- Decoupling the engine from concrete Postgres wiring (injecting `acquireLeader`/`wakeupStream`) is
  what let Bun unit tests use a fake always-leader stub and a manually-driven `PubSub` instead of a
  real database — a deliberate design choice made to keep the fast unit suite fast.
- The generic `SqlEventFetcher` includes a `transaction_id < pg_snapshot_xmin(...)` visibility
  filter, verified by a dedicated two-transaction test (a higher position that commits first stays
  invisible until a still-open lower position also commits) — not explicit in the Java ground
  truth, but directly analogous to `append_events_if()`'s own conflict-check reasoning (ADR-0003).
