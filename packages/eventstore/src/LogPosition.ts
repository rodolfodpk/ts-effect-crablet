// A point in the global event log: `position` is the event's sequence number, `transactionId` the
// Postgres transaction that appended it. There are no per-entity streams in this framework, so this
// is a position in the ONE shared log (what `load` returns and what an append condition compares
// against: "fail if anything matching this query appeared after position N").
export interface LogPosition {
  readonly position: bigint;
  readonly occurredAt: Date | null;
  readonly transactionId: string | null;
}

// A plain function that throws does the validation - there's no
// constructor to hook into for a plain `interface`, so validation just lives in the one factory
// function every caller is expected to go through. This throw is a genuine (uncaught, defect-style)
// exception, not an Effect failure - LogPosition values are constructed synchronously outside
// any Effect, so there's no typed error channel to put it in.
export const of = (position: bigint, occurredAt: Date, transactionId: string): LogPosition => {
  if (position < 0n) throw new Error("LogPosition cannot be negative");
  return { position, occurredAt, transactionId };
};

export const zero = (): LogPosition => ({ position: 0n, occurredAt: new Date(0), transactionId: "0" });
