import { Context, Duration, Effect, Latch, Layer, Queue, Scope } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { SqlError } from "effect/sql/SqlError";
import { VIEW_PROGRESS_CHANNEL, decodeViewProgressPing, type ViewProgressPing } from "./ViewProgress.ts";

// One `LISTEN crablet_view_progress` for the whole process, and a fan-out in memory (ADR-0016).
//
// A view's progress ping (ADR-0014) is wanted in two places: the live feed, which tells pages "this view moved", and the wait of a consistent
// read, which needs to know when a view has reached a write. Each used to ask the database for itself (a pooled connection per open page; a poll
// every 25 ms per waiting reader). The hub holds the one connection and hands each ping to everyone who asked for that view.
//
// A subscriber does not get a queue of pings. It gets the LATEST ping per view it asked for, plus a `resync` flag, and is woken when either
// changes. That bounds its memory by the number of views, and a slow subscriber cannot lose "view X moved": it may skip the older pings of X,
// which a hint does not need, but never the newest. `resync` means "a ping may have been missed, so look at the state yourself": it is set on
// every (re)connect of the hub's LISTEN, the first included.

// Where notifications come from: a queue of payloads, handed out once LISTEN is confirmed and valid until the scope closes. If the connection
// drops, the queue fails (that is what `PgClient.listen` does) and the hub starts again.
export type ListenSource = Effect.Effect<Queue.Dequeue<{ readonly payload: string }, SqlError>, SqlError, Scope.Scope>;

export interface ProgressBatch {
  // The newest ping of each subscribed view that moved since the last `next`.
  readonly pings: ReadonlyArray<ViewProgressPing>;
  // The hub (re)connected since the last `next`: re-read the state, a ping may have been missed.
  readonly resync: boolean;
}

export interface ProgressSubscription {
  // Waits until there is a ping for a view this subscription asked for, or a resync, and returns what accumulated. Never returns an empty batch.
  readonly next: Effect.Effect<ProgressBatch>;
}

export interface ViewProgressHubService {
  // `null` asks for every view. The subscription is removed when the scope closes.
  readonly subscribe: (views: ReadonlySet<string> | null) => Effect.Effect<ProgressSubscription, never, Scope.Scope>;
  // Is LISTEN established right now? While it is not, no pings arrive: callers fall back to polling.
  readonly connected: Effect.Effect<boolean>;
  readonly subscriberCount: Effect.Effect<number>;
}

export class ViewProgressHub extends Context.Service<ViewProgressHub, ViewProgressHubService>()("ViewProgressHub") {}

export interface ViewProgressHubOptions {
  readonly source: ListenSource;
  // Delay before LISTEN is retried: `retryBase`, doubling after each failed attempt up to `retryMax`; back to `retryBase` after a connection
  // that was established and then lost.
  readonly retryBase?: Duration.Input;
  readonly retryMax?: Duration.Input;
}

interface Subscriber {
  readonly views: ReadonlySet<string> | null;
  readonly dirty: Map<string, ViewProgressPing>;
  resync: boolean;
  readonly latch: Latch.Latch;
}

// Builds the hub and starts its connection loop in the ambient scope (the loop stops when the scope closes).
export const makeViewProgressHub = (options: ViewProgressHubOptions): Effect.Effect<ViewProgressHubService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const retryBase = Duration.toMillis(Duration.fromInputUnsafe(options.retryBase ?? "500 millis"));
    const retryMax = Duration.toMillis(Duration.fromInputUnsafe(options.retryMax ?? "30 seconds"));
    const subscribers = new Set<Subscriber>();
    let connected = false;

    const publish = (ping: ViewProgressPing): void => {
      for (const subscriber of subscribers) {
        if (subscriber.views === null || subscriber.views.has(ping.id)) {
          subscriber.dirty.set(ping.id, ping);
          subscriber.latch.openUnsafe();
        }
      }
    };
    const resyncAll = (): void => {
      for (const subscriber of subscribers) {
        subscriber.resync = true;
        subscriber.latch.openUnsafe();
      }
    };

    // One connection's life: LISTEN, announce, then pass pings on until the queue fails or ends. Ends with whatever ended it.
    const connection = Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* options.source;
        connected = true;
        resyncAll();
        for (;;) {
          const notification = yield* Queue.take(queue);
          // a payload that is not a ping cannot be from this module's tracker: drop it
          yield* Effect.match(decodeViewProgressPing(notification.payload), { onFailure: () => undefined, onSuccess: publish });
        }
      })
    );

    const run = Effect.gen(function* () {
      let delay = retryBase;
      for (;;) {
        // ends when LISTEN fails or the connection is lost, whatever the reason
        yield* Effect.exit(connection);
        const wasConnected = connected; // `connection` sets it once LISTEN was confirmed
        connected = false;
        yield* Effect.sleep(Duration.millis(wasConnected ? retryBase : delay));
        delay = wasConnected ? retryBase : Math.min(delay * 2, retryMax);
      }
    });
    yield* Effect.forkScoped(run);

    const take = (subscriber: Subscriber): Effect.Effect<ProgressBatch> =>
      Effect.gen(function* () {
        for (;;) {
          yield* subscriber.latch.await;
          // Close BEFORE reading: a ping that arrives after this re-opens the latch, so it is never lost. At worst a ping that arrived between
          // `await` and `close` is read now and the latch is opened again for nothing, which gives one empty round that the loop absorbs.
          subscriber.latch.closeUnsafe();
          if (subscriber.dirty.size > 0 || subscriber.resync) {
            const batch: ProgressBatch = { pings: [...subscriber.dirty.values()], resync: subscriber.resync };
            subscriber.dirty.clear();
            subscriber.resync = false;
            return batch;
          }
        }
      });

    const service: ViewProgressHubService = {
      subscribe: (views) =>
        Effect.map(
          Effect.acquireRelease(
            Effect.sync(() => {
              const subscriber: Subscriber = { views, dirty: new Map(), resync: false, latch: Latch.makeUnsafe(false) };
              subscribers.add(subscriber);
              return subscriber;
            }),
            (subscriber) => Effect.sync(() => void subscribers.delete(subscriber))
          ),
          (subscriber): ProgressSubscription => ({ next: take(subscriber) })
        ),
      connected: Effect.sync(() => connected),
      subscriberCount: Effect.sync(() => subscribers.size)
    };
    return service;
  });

// The hub for an app: one LISTEN on `crablet_view_progress` over the app's PgClient, for the life of the layer. Build it ONCE and provide it to
// everything that needs it (the feed, the read wrapper): Effect shares one layer value within a build, so they share the one connection.
export const ViewProgressHubLive: Layer.Layer<ViewProgressHub, never, PgClient.PgClient> = Layer.effect(
  ViewProgressHub,
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    return yield* makeViewProgressHub({ source: pg.listen(VIEW_PROGRESS_CHANNEL) });
  })
);
