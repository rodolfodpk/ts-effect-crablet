import * as Schema from "effect/Schema";

// What a progress tracker with `notifyChannel` sends after it advances a processor: which processor (for views, the view's name) and how far
// it has got, as the same `(transactionId, position)` pair a cursor is. A ping carries no data from the events themselves. It is a hint to
// look again, and it is not stored: a listener that was not connected misses it and must re-read.
export const ProgressPing = Schema.Struct({
  id: Schema.String,
  transactionId: Schema.String,
  position: Schema.String
});
export type ProgressPing = typeof ProgressPing.Type;

export const decodeProgressPing = (payload: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(ProgressPing))(payload);
