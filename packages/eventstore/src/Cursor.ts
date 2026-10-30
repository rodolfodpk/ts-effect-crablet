// Where a paged read stopped (`EventStoreService.read`, `stream`): the (transaction id, position) of the last event it returned, the order events are
// read in. Opaque: a reader passes it back as `after`, or keeps it as text (`toString`, `fromString`) to resume later, say an export. A paged read only
// returns events whose transaction had finished, so no event can later appear behind a cursor (ADR-0050, ADR-0012).
declare const brand: unique symbol;
export type Cursor = string & { readonly [brand]: "Cursor" };

const FORM = /^(\d+)\/(\d+)$/;

// Before the first event.
export const start: Cursor = "0/0" as Cursor;

export const toString = (cursor: Cursor): string => cursor;

// A cursor kept as text; anything else is refused.
export const fromString = (text: string): Cursor => {
  if (!FORM.test(text)) throw new Error(`not a cursor: ${JSON.stringify(text)}`);
  return text as Cursor;
};

// For the stores: the cursor of an event, and a cursor's parts.
export const of = (transactionId: string, position: bigint): Cursor => fromString(`${transactionId}/${position}`);
export const parts = (cursor: Cursor): { readonly transactionId: string; readonly position: bigint } => {
  const match = FORM.exec(cursor)!;
  return { transactionId: match[1]!, position: BigInt(match[2]!) };
};
