// Where a paged read stopped (`EventStoreService.read`, `stream`): the `LogPoint` of the last event it returned, the order events are read in.
// Opaque: a reader passes it back as `after`, or keeps it as text (`toString`, `fromString`) to resume later, say an export. Its text is a
// LogPoint's, `"<transactionId>:<position>"`. A paged read only returns events whose transaction had finished, so no event can later appear
// behind a cursor (ADR-0050, ADR-0012).
import * as LogPoint from "./LogPoint.ts";

declare const brand: unique symbol;
export type Cursor = string & { readonly [brand]: "Cursor" };

// A cursor kept as text; anything else is refused.
export const fromString = (text: string): Cursor => {
  if (LogPoint.parse(text) === null) throw new Error(`not a cursor: ${JSON.stringify(text)}`);
  return text as Cursor;
};

// Before the first event.
export const start: Cursor = fromString(LogPoint.format(LogPoint.zero));

export const toString = (cursor: Cursor): string => cursor;

// For the stores: the cursor of an event, and a cursor's parts.
export const of = (transactionId: string, position: bigint): Cursor => fromString(LogPoint.format(LogPoint.of(transactionId, position)));
export const parts = (cursor: Cursor): LogPoint.LogPoint => LogPoint.parse(cursor)!;
