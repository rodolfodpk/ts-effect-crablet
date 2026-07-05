// Port of com.crablet.eventstore.StreamPosition.
export interface StreamPosition {
  readonly position: bigint;
  readonly occurredAt: Date | null;
  readonly transactionId: string | null;
}

// A plain function that throws replaces Java's validating constructor here - there's no
// constructor to hook into for a plain `interface`, so validation just lives in the one factory
// function every caller is expected to go through. This throw is a genuine (uncaught, defect-style)
// exception, not an Effect failure - StreamPosition values are constructed synchronously outside
// any Effect, so there's no typed error channel to put it in.
export const of = (position: bigint, occurredAt: Date, transactionId: string): StreamPosition => {
  if (position < 0n) throw new Error("StreamPosition cannot be negative");
  return { position, occurredAt, transactionId };
};

export const zero = (): StreamPosition => ({ position: 0n, occurredAt: new Date(0), transactionId: "0" });
