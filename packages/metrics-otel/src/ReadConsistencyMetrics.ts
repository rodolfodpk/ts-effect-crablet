import { Metric } from "effect";

// crablet.read.consistency. One count per read that went through a consistency wrapper. Tag with ("mode", strict|bounded|eventual) and
// ("outcome", ...):
//   skipped      no wait was asked for (no marker and whenNoMarker none, or eventual)
//   caught_up    every view the read uses had reached the target
//   stale        a bounded read was answered although a view was behind (or failed)
//   timeout      a strict read was refused: a view did not catch up in time
//   view_failed  a strict read was refused: a view is FAILED
export const reads = Metric.counter("crablet.read.consistency.reads");

// How long reads spent waiting for views (only reads that waited). Tag with ("mode", ...).
export const waitDuration = Metric.timer("crablet.read.consistency.wait.duration");
