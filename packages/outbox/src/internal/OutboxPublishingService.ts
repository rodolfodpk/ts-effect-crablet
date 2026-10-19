import { Duration, Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { HandledPrefix } from "@crablet/event-poller/EventHandler";
import type { OutboxPublisher } from "../OutboxPublisher.ts";

// A publish that took longer than the module's `publishTimeoutMs`.
export class PublishTimedOut extends Error {
  override readonly name = "PublishTimedOut";
}

// Calls publishBatch once for the whole batch, or once per event if the publisher opts into "individual" mode; each call may take at most `timeoutMs`.
// In individual mode a failure after some events were published reports how many (HandledPrefix), so the processor keeps them and publishes again from
// the first that failed, not the whole batch (ADR-0036).
export const publishToOutbox = (
  publisher: OutboxPublisher,
  events: ReadonlyArray<StoredEvent>,
  timeoutMs: number
): Effect.Effect<number, unknown, never> => {
  const publish = (batch: ReadonlyArray<StoredEvent>) =>
    publisher.publishBatch(batch).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new PublishTimedOut(`publisher "${publisher.name}": publishing ${batch.length} event(s) took longer than ${timeoutMs} ms`))
      })
    );
  if (publisher.preferredMode !== "individual") return publish(events).pipe(Effect.map(() => events.length));
  return Effect.gen(function* () {
    for (let i = 0; i < events.length; i++) {
      yield* publish([events[i]!]).pipe(Effect.mapError((cause) => (i === 0 ? cause : new HandledPrefix({ handled: i, cause }))));
    }
    return events.length;
  });
};
