import os from "node:os";

// Port of the instance-id concept LeaderElectorImpl/ProgressTracker use to record which process is
// currently acting as leader. Not a stable identity across restarts (matches Java's own
// hostname/pod-name-based approach) - only used for observability, never for correctness.
export const defaultInstanceId = (): string => `${os.hostname()}-${process.pid}`;
