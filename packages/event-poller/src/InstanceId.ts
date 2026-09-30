import os from "node:os";

// Identifies which process is currently acting as leader (hostname/pod-name based). Not a stable
// identity across restarts - only used for observability, never for correctness.
export const defaultInstanceId = (): string => `${os.hostname()}-${process.pid}`;
