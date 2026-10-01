// What a successful append reports back.
export interface AppendResult {
  // The database transaction the events were written in (shared by every event of one command).
  readonly transactionId: string;
  // The log position of the LAST event appended. A caller that wants to read its own write from an
  // asynchronous projection waits until that projection's progress has passed it.
  readonly lastPosition: bigint;
}
