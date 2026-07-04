// Port of com.crablet.eventstore.StreamPosition.
export interface StreamPosition {
  readonly position: bigint;
  readonly occurredAt: Date | null;
  readonly transactionId: string | null;
}

export const of = (position: bigint, occurredAt: Date, transactionId: string): StreamPosition => {
  if (position < 0n) throw new Error("StreamPosition cannot be negative");
  return { position, occurredAt, transactionId };
};

export const zero = (): StreamPosition => ({ position: 0n, occurredAt: new Date(0), transactionId: "0" });
