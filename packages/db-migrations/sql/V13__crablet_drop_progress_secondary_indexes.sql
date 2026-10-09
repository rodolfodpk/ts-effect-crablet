-- Secondary indexes on the progress tables are removed.
--
-- V3 created nine (status, instance_id, last_updated_at on the view and automation tables; topic/status, topic/leader, topic/publisher/heartbeat on the outbox
-- table). Measured on a running system, eight were never read and no code filters on those columns: these tables hold one row per processor and are read by primary
-- key. Each index also blocked HOT updates, and every tick writes last_updated_at / heartbeat, so the share of HOT updates went from 13% and 50% to 100% once they
-- were gone. The tables are tiny, so a sequential scan stays cheaper than any index if a filter is ever added.

DROP INDEX IF EXISTS idx_crablet_outbox_topic_status;
DROP INDEX IF EXISTS idx_crablet_outbox_topic_leader;
DROP INDEX IF EXISTS idx_crablet_outbox_topic_publisher_heartbeat;
DROP INDEX IF EXISTS idx_crablet_view_progress_status;
DROP INDEX IF EXISTS idx_crablet_view_progress_instance;
DROP INDEX IF EXISTS idx_crablet_view_progress_last_updated;
DROP INDEX IF EXISTS idx_crablet_automation_progress_status;
DROP INDEX IF EXISTS idx_crablet_automation_progress_instance;
DROP INDEX IF EXISTS idx_crablet_automation_progress_last_updated;
