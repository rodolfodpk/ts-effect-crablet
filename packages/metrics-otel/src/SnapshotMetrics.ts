import { Metric } from "effect";

// crablet.snapshot.loads. One count per load of a model that declares a snapshot. Tag with ("model", the snapshot name) and ("outcome", ...):
//   hit        a snapshot was used: only the events after its cursor were read
//   miss       none stored (or none for this entity/version): the full boundary was folded
//   invalid    one was stored but its state no longer decodes with the model's schema: ignored, full fold
//   unavailable the model declares a snapshot but there is no SnapshotStore in the context: full fold
export const loads = Metric.counter("crablet.snapshot.loads");

// Events folded by a load of a snapshotted model (the tail after a hit, the whole boundary otherwise). Tag with ("model", ...).
export const foldedEvents = Metric.counter("crablet.snapshot.folded_events");

// crablet.snapshot.writes. One count per pending snapshot the flush handled. Tag with ("model", ...) and ("outcome", written | not_newer | failed).
export const writes = Metric.counter("crablet.snapshot.writes");
