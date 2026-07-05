// Port of com.crablet.eventpoller.progress.ProcessorStatus. A plain string-literal union - matches
// the `status` TEXT column (CHECK-constrained to these three values) directly, no encode/decode step.
export type ProcessorStatus = "ACTIVE" | "PAUSED" | "FAILED";
