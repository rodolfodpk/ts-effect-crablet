import { Metric } from "effect";

// crablet.storage.* : how much space the library's tables take, so growth is seen before it is a problem (docs/adr/0019-storage-visibility-and-retention.md).
// Updated by `monitorStorage` (@crablet/eventstore/Storage) from the catalog, not on the write path.

// Bytes per table. Tag with ("table", name) and ("part", total | heap | indexes | toast).
export const tableBytes = Metric.gauge("crablet.storage.table_bytes");

// Estimated rows per table (the planner's estimate: cheap, and as fresh as the last autovacuum or ANALYZE). Tag with ("table", name).
export const tableRows = Metric.gauge("crablet.storage.table_rows");

// (events table + tag table) bytes divided by estimated events: what one event costs on disk (476 bytes in diagnostic E8, for a payload of about 70 bytes).
export const bytesPerEvent = Metric.gauge("crablet.storage.bytes_per_event");
