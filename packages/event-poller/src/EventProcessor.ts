import { Cause, Duration, Effect, Exit, Fiber, Metric, PubSub, Queue, Ref, Stream } from "effect";
import type { LeaderHandle } from "@crablet/eventstore/Leader";
import type { WakeupBatch } from "@crablet/eventstore/Listen";
import { shouldWake, type SubscriberFilter } from "@crablet/eventstore/NotifyPayload";
import * as PollerMetrics from "@crablet/metrics-otel/PollerMetrics";
import * as LeaderMetrics from "@crablet/metrics-otel/LeaderMetrics";
import type { ProcessorConfig } from "./ProcessorConfig.ts";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import type { ProgressTracker } from "./ProgressTracker.ts";
import type { EventFetcher } from "./EventFetcher.ts";
import type { EventHandler } from "./EventHandler.ts";
import * as EventSelectionNS from "./EventSelection.ts";
import type { EventSelection } from "./EventSelection.ts";
import * as BackoffStateNS from "./BackoffState.ts";
import type { BackoffState } from "./BackoffState.ts";

// Port of com.crablet.eventpoller.processor.EventProcessor<C,I> +
// com.crablet.eventpoller.internal.EventProcessorImpl.
//
// Java's model is one TaskScheduler one-shot self-resubmission per processorId, with an explicit
// "already running" guard needed because a LISTEN/NOTIFY wakeup can force a concurrent second
// invocation racing an in-flight scheduled one. The Effect-idiomatic replacement is one
// persistent, long-lived fiber per processorId (see makeEventProcessor's `processorLoop`):
// because a single dedicated fiber processes strictly sequentially by construction, that guard has
// no equivalent here - a structural simplification, not a missing feature.
export interface EventProcessorService<C extends ProcessorConfig<I>, I> {
  // Callable directly (mirrors Java's public process(I) - used by tests, does NOT check
  // leadership; the leadership gate lives only in the scheduled loop, same as Java).
  readonly process: (processorId: I) => Effect.Effect<number, unknown>;
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly pause: (processorId: I) => Effect.Effect<void, unknown>;
  readonly resume: (processorId: I) => Effect.Effect<void, unknown>;
  readonly getStatus: (processorId: I) => Effect.Effect<ProcessorStatus, unknown>;
  readonly getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown>;
}

// Minimal structural shape - deliberately not imported from ProcessorManagementService.ts to avoid
// a circular dependency; that module's BackoffInfo is structurally identical and wired to this via
// the backoffSnapshot/allBackoffSnapshots accessors below at composition time, not via import.
export interface BackoffSnapshot {
  readonly emptyPollCount: number;
  readonly currentSkipCounter: number;
}

// `acquireLeader`/`wakeupStream` are passed in already-built rather than as raw sql/pg + lockKey/
// channel parameters - the real composition site builds them via the existing
// tryAcquireGlobalLeader(sql, lockKey)/wakeupStream(pg, channel) primitives (Leader.ts/Listen.ts,
// reused as-is) and hands the results to this factory. This keeps EventProcessor decoupled from
// concrete Postgres wiring, which is what makes event-processor-loop.test.ts able to run under Bun
// with a fake always-leader stub and a manually-driven stream instead of a real database.
export interface EventProcessorDeps<C extends ProcessorConfig<I>, I extends string> {
  readonly configs: ReadonlyArray<C>;
  readonly fetcher: EventFetcher<I, unknown, never>;
  readonly handler: EventHandler<I, unknown, never>;
  readonly progressTracker: ProgressTracker<I>;
  readonly selectionOf: (config: C) => EventSelection;
  readonly instanceId: string;
  readonly acquireLeader: Effect.Effect<LeaderHandle | null, unknown>;
  readonly wakeupStream: Stream.Stream<WakeupBatch, unknown>;
  readonly leaderRetryIntervalMs?: number;
}

export interface EventProcessorHandle<C extends ProcessorConfig<I>, I extends string> {
  readonly service: EventProcessorService<C, I>;
  readonly backoffSnapshot: (processorId: I) => Effect.Effect<BackoffSnapshot | null>;
  readonly allBackoffSnapshots: Effect.Effect<ReadonlyMap<I, BackoffSnapshot>>;
}

const toBackoffSnapshot = (state: BackoffState): BackoffSnapshot => ({
  emptyPollCount: state.emptyPollCount,
  currentSkipCounter: state.skipCounter
});

const withPollerTags = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  tags: ReadonlyArray<readonly [string, string]>
): Metric.Metric<Type, In, Out> => tags.reduce((acc, [key, value]) => Metric.tagged(acc, key, value), metric);

export const makeEventProcessor = <C extends ProcessorConfig<I>, I extends string>(
  deps: EventProcessorDeps<C, I>
): Effect.Effect<EventProcessorHandle<C, I>> =>
  Effect.gen(function* () {
    // PATTERN PRIMER - `Ref<A>`, Effect's mutable cell (think `AtomicReference<A>`, or a `useRef`
    // that any fiber can read/write). `Ref.make(initial)` allocates it; `Ref.get`/`Ref.set`/
    // `Ref.update` are themselves `Effect`s, not plain synchronous field access - which matters
    // because it means reads/writes are automatically sequenced correctly by Effect's fiber
    // runtime even when multiple fibers touch the same `Ref` concurrently (no manual locking).
    // `leaderRef` and `backoffRef` are exactly the "impure shell" half of BackoffState.ts's
    // "functional core, imperative shell" primer: the *shape* of a backoff state transition is a
    // pure function (`BackoffState.recordEmpty`), but *where the current state lives* and *how
    // it's shared* across this module's several concurrent fibers (one per processorId, see
    // `processorLoop` below) is this `Ref`.
    const leaderRef = yield* Ref.make<LeaderHandle | null>(null);
    const backoffRef = yield* Ref.make<ReadonlyMap<I, BackoffState>>(new Map());
    const fibersRef = yield* Ref.make<ReadonlyArray<Fiber.RuntimeFiber<unknown, unknown>>>([]);

    // PATTERN PRIMER - `PubSub<A>`, a multi-subscriber broadcast queue (the Effect equivalent of a
    // hot `EventEmitter`/RxJS `Subject`, but typed and backpressure-aware). One producer
    // (`dispatcherLoop` below, draining the LISTEN/NOTIFY `Stream`) publishes into the hub; each
    // consumer calls `PubSub.subscribe(hub)` to get its OWN independent `Dequeue` - every
    // subscriber sees every published value, unlike a plain `Queue` where one value goes to
    // exactly one consumer. `PubSub.sliding(32)` picks the overflow strategy: once a slow
    // subscriber's own backlog hits 32 unread items, the OLDEST ones are silently dropped to make
    // room for new ones, rather than blocking the publisher or growing unboundedly. That's
    // deliberately fine here - a dropped wakeup notification only costs a slightly later poll, not
    // an incorrect one (see `waitForRelevantWakeup` below).
    const hub = yield* PubSub.sliding<WakeupBatch>(32);

    const configOf = (id: I): C | undefined => deps.configs.find((c) => c.processorId === id);

    // Mirrors EventProcessorImpl.process(I) exactly - the same 7-step sequence the scheduled loop
    // calls, but with NO leadership check (that gate lives only in `tick` below, same as Java).
    const process = (id: I): Effect.Effect<number, unknown> =>
      Effect.gen(function* () {
        const config = configOf(id);
        if (!config) return yield* Effect.die(new Error(`Unknown processorId: ${id}`));
        if (!config.enabled) return 0;

        const status = yield* deps.progressTracker.getStatus(id);
        if (status === "PAUSED" || status === "FAILED") return 0;

        const ready = yield* Effect.gen(function* () {
          yield* deps.progressTracker.autoRegister(id, deps.instanceId);
          const position = yield* deps.progressTracker.getLastPosition(id);
          return position;
        }).pipe(
          Effect.map((position): { ready: true; position: bigint } => ({ ready: true, position })),
          Effect.catchTag("ProgressTableNotReady", () =>
            Effect.succeed<{ ready: false }>({ ready: false })
          )
        );
        if (!ready.ready) return 0;

        const events = yield* deps.fetcher.fetchEvents(id, ready.position, config.batchSize);
        if (events.length === 0) return 0;

        const handled = yield* deps.handler.handle(id, events).pipe(
          Effect.tapError((err) => deps.progressTracker.recordError(id, String(err), config.maxErrors))
        );

        yield* deps.progressTracker.updateProgress(id, events[events.length - 1]!.position);
        yield* deps.progressTracker.resetErrorCount(id);
        return handled;
      });

    const waitForRelevantWakeup = (
      dequeue: Queue.Dequeue<WakeupBatch>,
      filter: SubscriberFilter
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const batch = yield* Queue.take(dequeue);
        if (!shouldWake(batch, filter)) {
          yield* waitForRelevantWakeup(dequeue, filter);
        }
      });

    // One iteration of a processorId's loop - mirrors EventProcessorImpl.scheduledTask's 7-step
    // sequence exactly, including the subtle Java detail that on ANY exception the backoff state
    // is left untouched and the next delay falls back to the plain pollingIntervalMs (not the
    // backoff-adjusted delay) since Java's nextDelayMs is only overwritten by the backoff-update
    // block, which never runs on the exception path.
    const tick = (
      config: C,
      dequeue: Queue.Dequeue<WakeupBatch>,
      filter: SubscriberFilter
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const leader = yield* Ref.get(leaderRef);
        const isLeader = leader !== null && leader.isLeader();

        // PATTERN PRIMER - `Effect.race(a, b)`: runs both effects concurrently, returns whichever
        // finishes first, and automatically *interrupts* the loser (Effect's fiber interruption is
        // cooperative and safe to run at almost any suspension point - it's not like a Java
        // `Thread.interrupt()` that might leave things half-done). This is the entire mechanism
        // behind "sleep for the polling interval, but wake up early if a LISTEN/NOTIFY arrives":
        // whichever of `Effect.sleep(delay)` / `waitForRelevantWakeup(...)` resolves first wins,
        // and the still-waiting other one is cleanly cancelled - no manual timer-handle
        // bookkeeping (`clearTimeout`-equivalent) needed anywhere in this file.
        if (!isLeader) {
          yield* Effect.race(
            Effect.sleep(Duration.millis(config.pollingIntervalMs)),
            waitForRelevantWakeup(dequeue, filter)
          );
          return;
        }

        // PATTERN PRIMER - `Effect.exit(effect)` converts "success A or failure E" into a plain
        // `Exit<A, E>` *value* you can pattern-match on, instead of letting a failure propagate as
        // this function's own failure. It's the Effect equivalent of wrapping a call in
        // `try { ... } catch (e) { ... }` specifically because you need to inspect/react to the
        // outcome yourself rather than letting it bubble - here, so a handler exception can be
        // logged and leave backoff state untouched (matching a subtle Java behavior - see the
        // comment below) instead of aborting this whole tick. `Exit.isSuccess(exit)` narrows the
        // type so `exit.value`/`exit.cause` are safe to read in each branch.
        const exit = yield* Effect.exit(process(config.processorId));

        if (Exit.isSuccess(exit)) {
          const handled = exit.value;

          // Instrumented once here, in the shared engine, so every consumer built on it
          // (views/outbox/automations) gets cycle/backoff metrics for free - see ADR-0007's "one
          // shared engine, zero per-consumer duplication" win, just for metrics instead of
          // scheduling.
          const pollerTags: ReadonlyArray<readonly [string, string]> = [
            ["processor", String(config.processorId)],
            ["instance_id", deps.instanceId]
          ];
          yield* Metric.increment(withPollerTags(PollerMetrics.processingCycles, pollerTags));
          yield* Metric.incrementBy(withPollerTags(PollerMetrics.eventsFetched, pollerTags), handled);
          if (handled === 0) yield* Metric.increment(withPollerTags(PollerMetrics.emptyPolls, pollerTags));

          const currentBackoff = (yield* Ref.get(backoffRef)).get(config.processorId) ?? BackoffStateNS.init();
          const updatedBackoff = config.backoffEnabled
            ? handled > 0
              ? BackoffStateNS.recordSuccess()
              : BackoffStateNS.recordEmpty(currentBackoff, {
                  threshold: config.backoffThreshold,
                  multiplier: config.backoffMultiplier,
                  pollingIntervalMs: config.pollingIntervalMs,
                  maxBackoffSeconds: config.backoffMaxSeconds
                })
            : currentBackoff;
          yield* Ref.update(backoffRef, (m) => new Map(m).set(config.processorId, updatedBackoff));
          yield* Metric.set(withPollerTags(PollerMetrics.backoffActive, pollerTags), updatedBackoff.skipCounter > 0 ? 1 : 0);
          yield* Metric.set(withPollerTags(PollerMetrics.backoffEmptyPollCount, pollerTags), updatedBackoff.emptyPollCount);

          const delayMs = config.backoffEnabled
            ? BackoffStateNS.nextDelayMs(updatedBackoff, config.pollingIntervalMs)
            : config.pollingIntervalMs;

          yield* Effect.race(Effect.sleep(Duration.millis(delayMs)), waitForRelevantWakeup(dequeue, filter));
        } else {
          yield* Effect.logError(Cause.pretty(exit.cause));
          yield* Effect.race(
            Effect.sleep(Duration.millis(config.pollingIntervalMs)),
            waitForRelevantWakeup(dequeue, filter)
          );
        }
      });

    // Persistent, long-lived fiber - see the module doc comment for why this eliminates the
    // "already running" guard Java's resubmit-to-executor model needs.
    //
    // `Effect.scoped(effect)` opens a `Scope` (see eventstore's Leader.ts for the full Scope
    // primer), runs `effect`, and closes the scope - releasing anything registered against it -
    // the instant `effect` completes or is interrupted. `PubSub.subscribe(hub)` needs exactly this:
    // a subscription must eventually be released (so the hub can stop tracking it), and since this
    // whole loop runs forever until the fiber itself is interrupted (by `stop()`, below), the
    // natural place to release the subscription is "whenever this fiber ends" - which is precisely
    // what wrapping the entire `Effect.forever(...)` loop in one `Effect.scoped(...)` gives us.
    //
    // `Effect.forever(effect)` repeats `effect` indefinitely. This is NOT the same as writing a
    // recursive function that calls itself in JS - a naive recursive `Effect.gen` loop would still
    // be safe here too, because Effect's fiber runtime trampolines through `yield*` points rather
    // than growing the actual JS call stack, but `Effect.forever` says the *intent* ("repeat this
    // forever") directly instead of encoding it as recursion.
    const processorLoop = (config: C): Effect.Effect<void> =>
      Effect.scoped(
        Effect.gen(function* () {
          const dequeue = yield* PubSub.subscribe(hub);
          const filter = EventSelectionNS.toSubscriberFilter(deps.selectionOf(config));
          yield* Effect.forever(tick(config, dequeue, filter));
        })
      );

    const leaderRetryIntervalMs =
      deps.leaderRetryIntervalMs ??
      deps.configs.find((c) => c.enabled)?.leaderElectionRetryIntervalMs ??
      30_000;

    const acquireLeaderSafe: Effect.Effect<LeaderHandle | null> = deps.acquireLeader.pipe(
      Effect.catchAll((e) => Effect.zipRight(Effect.logError("acquireLeader failed", e), Effect.succeed(null)))
    );

    // Port of crablet.poller.leadership - set on every leadership state transition, tagged by
    // lock_key (this module's fixed lock, e.g. VIEWS_LOCK_KEY - the closest TS equivalent of
    // Java's per-LeaderElector "processor" identity, since leadership here is module-wide, not
    // per-processorId) and instance_id.
    const setLeadershipGauge = (handle: LeaderHandle, isLeader: boolean): Effect.Effect<void> =>
      Metric.set(
        withPollerTags(LeaderMetrics.leadership, [
          ["lock_key", handle.lockKey.toString()],
          ["instance_id", deps.instanceId]
        ]),
        isLeader ? 1 : 0
      );

    // One shared retry fiber per module (not per-processorId) - see disclosed simplification in
    // the Phase 2 plan: Java's two-tier timing (30s shared task + 5s per-tick cooldown) exists to
    // stop many independently-scheduled per-processor tasks from hammering pg_try_advisory_lock
    // simultaneously; since only this one fiber ever attempts acquisition, that problem doesn't
    // arise the same way.
    const leaderRetryLoop: Effect.Effect<void> = Effect.forever(
      Effect.gen(function* () {
        const current = yield* Ref.get(leaderRef);
        if (current === null || !current.isLeader()) {
          if (current !== null) yield* setLeadershipGauge(current, false);
          const handle = yield* acquireLeaderSafe;
          if (handle !== null) {
            yield* Ref.set(leaderRef, handle);
            yield* setLeadershipGauge(handle, true);
          }
        }
        yield* Effect.sleep(Duration.millis(leaderRetryIntervalMs));
      })
    );

    const dispatcherLoop: Effect.Effect<void> = Stream.runForEach(deps.wakeupStream, (batch: WakeupBatch) =>
      PubSub.publish(hub, batch)
    ).pipe(Effect.catchAll((e) => Effect.logError(String(e))));

    const start: Effect.Effect<void> = Effect.gen(function* () {
      const initialHandle = yield* acquireLeaderSafe;
      if (initialHandle !== null) {
        yield* Ref.set(leaderRef, initialHandle);
        yield* setLeadershipGauge(initialHandle, true);
      }

      // PATTERN PRIMER - `Effect.fork` vs `Effect.forkDaemon`. Effect defaults to "structured
      // concurrency": a fiber created with `Effect.fork` becomes a *child* of whatever fiber called
      // fork, and children are automatically interrupted when their parent fiber ends - by design,
      // so you can't accidentally leak background work past the lifetime of the code block that
      // started it (this is a real, hard-won lesson from this port - see NOTES.md's Phase 2
      // write-up for the bug it caused here). `Effect.forkDaemon` opts out of that supervision:
      // the fiber is attached to the runtime's root scope instead of its immediate caller, so it
      // keeps running independently for as long as the whole program runs, or until something
      // explicitly interrupts it. forkDaemon, not fork, is required here specifically because
      // `start`'s own fiber completes (returns) almost immediately after forking - a plain fork
      // would have Effect interrupt these fibers right away, before they ever get to do anything.
      // forkDaemon detaches them from `start`'s fiber entirely; their lifetime is managed
      // explicitly via fibersRef + stop()'s Fiber.interruptAll instead.
      const dispatcherFiber = yield* Effect.forkDaemon(dispatcherLoop);
      const leaderFiber = yield* Effect.forkDaemon(leaderRetryLoop);
      const processorFibers = yield* Effect.forEach(deps.configs, (config) =>
        Effect.forkDaemon(processorLoop(config))
      );

      yield* Ref.set(fibersRef, [dispatcherFiber, leaderFiber, ...processorFibers]);
    });

    const stop: Effect.Effect<void> = Effect.gen(function* () {
      const fibers = yield* Ref.get(fibersRef);
      yield* Fiber.interruptAll(fibers);
      yield* Ref.set(fibersRef, []);

      const leader = yield* Ref.get(leaderRef);
      if (leader !== null) {
        yield* leader.release();
        yield* Ref.set(leaderRef, null);
      }
    });

    const pause = (id: I): Effect.Effect<void, unknown> => deps.progressTracker.setStatus(id, "PAUSED");
    const resume = (id: I): Effect.Effect<void, unknown> => deps.progressTracker.setStatus(id, "ACTIVE");
    const getStatus = (id: I): Effect.Effect<ProcessorStatus, unknown> => deps.progressTracker.getStatus(id);
    const getAllStatuses: Effect.Effect<ReadonlyMap<I, ProcessorStatus>, unknown> = Effect.map(
      Effect.forEach(deps.configs, (config) =>
        Effect.map(
          deps.progressTracker.getStatus(config.processorId),
          (status) => [config.processorId, status] as const
        )
      ),
      (entries) => new Map(entries)
    );

    const service: EventProcessorService<C, I> = {
      process,
      start,
      stop,
      pause,
      resume,
      getStatus,
      getAllStatuses
    };

    const backoffSnapshot = (id: I): Effect.Effect<BackoffSnapshot | null> =>
      Effect.map(Ref.get(backoffRef), (m) => {
        const state = m.get(id);
        return state ? toBackoffSnapshot(state) : null;
      });

    const allBackoffSnapshots: Effect.Effect<ReadonlyMap<I, BackoffSnapshot>> = Effect.map(
      Ref.get(backoffRef),
      (m) => new Map([...m.entries()].map(([id, state]) => [id, toBackoffSnapshot(state)]))
    );

    const handle: EventProcessorHandle<C, I> = { service, backoffSnapshot, allBackoffSnapshots };
    return handle;
  });
