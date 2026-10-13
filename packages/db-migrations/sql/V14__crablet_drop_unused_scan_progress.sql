-- V3 created two tables, crablet_module_scan_progress and crablet_processor_scan_progress, for a scan position per module and per processor. Nothing in the
-- framework has ever read or written them (the pollers keep their cursor in crablet_view_progress, crablet_automation_progress and crablet_outbox_topic_progress),
-- so they only add two empty tables to every application's database. Drop them.
--
-- IF EXISTS: the migration can be re-applied, and a database that never had them (or lost them) is fine.
DROP TABLE IF EXISTS crablet_processor_scan_progress;
DROP TABLE IF EXISTS crablet_module_scan_progress;
