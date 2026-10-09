import { Clock, Context, Duration, Effect, Metric, Ref } from "effect";
import * as EventStoreMetrics from "@crablet/metrics-otel/EventStoreMetrics";
import { encodePayload } from "../NotifyPayload.ts";

// The wake-up notifier (ADR-0021): collects the event types and tag keys of what was appended and sends ONE `pg_notify` for them, after the commit, instead of one inside every append.
//
// - Leading edge: if nothing was sent in the last `windowMs`, a signal is sent at once, so an idle system adds no latency.
// - Trailing edge: otherwise it is merged into what is pending, and one timer sends the union when the window ends. At most one notification per window.
// A wake-up is only a hint (the cursor decides what a processor sees), so a failed send is logged and not retried; the pollers' own interval is the safety net.
export interface WakeupNotifier {
  readonly signal: (types: ReadonlySet<string>, tagKeys: ReadonlySet<string>) => Effect.Effect<void>;
}

// What one transaction (or one append outside any) has appended and not yet signalled. `withWakeups` gives each its own, so one command's flush never sends
// another's uncommitted types, and never "uses up" the entry another command is still waiting to commit.
export interface PendingWakeups {
  readonly types: Set<string>;
  readonly tagKeys: Set<string>;
}
export const PendingWakeups = Context.Reference<PendingWakeups | null>("crablet/PendingWakeups", { defaultValue: () => null });

interface State {
  readonly types: ReadonlySet<string>;
  readonly tagKeys: ReadonlySet<string>;
  readonly lastSentAt: number | null;
  readonly timerScheduled: boolean;
}

type Action =
  | { readonly _tag: "send"; readonly payload: string }
  | { readonly _tag: "schedule"; readonly delayMs: number }
  | { readonly _tag: "merged" };

const union = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> => new Set([...a, ...b]);
const none: ReadonlySet<string> = new Set();

export const makeWakeupNotifier = (send: (payload: string) => Effect.Effect<void, unknown>, windowMs: number): Effect.Effect<WakeupNotifier> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ types: none, tagKeys: none, lastSentAt: null, timerScheduled: false });

    const deliver = (payload: string): Effect.Effect<void> =>
      send(payload).pipe(
        Effect.andThen(Metric.update(EventStoreMetrics.wakeupsSent, 1)),
        Effect.catchCause((cause) => Effect.logWarning(`wake-up notification not sent (the pollers' interval covers it): ${String(cause)}`))
      );

    // The timer: wait out the rest of the window, then send everything that was merged meanwhile.
    const trailing = (delayMs: number): Effect.Effect<void> =>
      Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) =>
          Ref.modify(state, (s): readonly [string, State] => [encodePayload(s.types, s.tagKeys), { types: none, tagKeys: none, lastSentAt: now, timerScheduled: false }])
        ),
        Effect.flatMap(deliver)
      );

    const signal = (types: ReadonlySet<string>, tagKeys: ReadonlySet<string>): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Metric.update(EventStoreMetrics.wakeupsRecorded, 1);
        const now = yield* Clock.currentTimeMillis;
        const action = yield* Ref.modify(state, (s): readonly [Action, State] => {
          const mergedTypes = union(s.types, types);
          const mergedKeys = union(s.tagKeys, tagKeys);
          if (s.timerScheduled) return [{ _tag: "merged" }, { ...s, types: mergedTypes, tagKeys: mergedKeys }];
          if (s.lastSentAt === null || now - s.lastSentAt >= windowMs) {
            return [{ _tag: "send", payload: encodePayload(mergedTypes, mergedKeys) }, { types: none, tagKeys: none, lastSentAt: now, timerScheduled: false }];
          }
          return [{ _tag: "schedule", delayMs: s.lastSentAt + windowMs - now }, { ...s, types: mergedTypes, tagKeys: mergedKeys, timerScheduled: true }];
        });
        if (action._tag === "send") yield* deliver(action.payload);
        else if (action._tag === "schedule") yield* Effect.forkDetach(trailing(action.delayMs));
        else yield* Metric.update(EventStoreMetrics.wakeupsSaved, 1);
      });

    return { signal };
  });
