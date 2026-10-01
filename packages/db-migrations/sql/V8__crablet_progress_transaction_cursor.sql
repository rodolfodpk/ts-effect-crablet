-- Progress cursors become (transaction_id, position) pairs.
--
-- The pollers (views, outbox, automations) kept a bare position and fetched `position > cursor AND
-- transaction_id < xmin`. But `position` comes from nextval() and `transaction_id` is the xid of the inserting
-- transaction, and the two can be taken in opposite orders: a transaction with the LOWER xid and the HIGHER
-- position can commit while another transaction (higher xid, lower position) is still open. The poller then
-- reads the first row, moves its cursor past the second transaction's position, and that row is behind the
-- cursor for ever. A cursor on (transaction_id, position) cannot skip: every xid below xmin belongs to a
-- finished transaction, and a row that appears later has an xid at or above that xmin, so it sorts after
-- every row already delivered.
--
-- last_position stays (lag display, operations); last_transaction_id is the new first half of the cursor.

-- The transaction id half of the cursor for a progress row that only has a position. A row's old cursor says
-- "everything above last_position is undelivered", which includes an event with a LOWER xid but a HIGHER
-- position than the one at last_position (the very case above). So the backfilled xid is the smaller of the
-- xid at last_position and the smallest xid among later events: it may redeliver a few events (handlers are
-- at-least-once), it never skips one.
CREATE OR REPLACE FUNCTION crablet_progress_cursor_xid(p_last_position BIGINT) RETURNS XID8 AS
$$
SELECT CASE
           WHEN p_last_position = 0 THEN '0'::xid8
           ELSE COALESCE(
                   LEAST((SELECT e.transaction_id FROM crablet_events e WHERE e.position = p_last_position),
                         (SELECT MIN(e.transaction_id) FROM crablet_events e WHERE e.position > p_last_position)),
                   -- the event at last_position is gone and nothing is newer: everything left was processed
                   (SELECT MAX(e.transaction_id) FROM crablet_events e),
                   '0'::xid8)
       END
$$ LANGUAGE sql STABLE;

ALTER TABLE crablet_view_progress
    ADD COLUMN last_transaction_id XID8 NOT NULL DEFAULT '0';
ALTER TABLE crablet_automation_progress
    ADD COLUMN last_transaction_id XID8 NOT NULL DEFAULT '0';
ALTER TABLE crablet_outbox_topic_progress
    ADD COLUMN last_transaction_id XID8 NOT NULL DEFAULT '0';

UPDATE crablet_view_progress SET last_transaction_id = crablet_progress_cursor_xid(last_position);
UPDATE crablet_automation_progress SET last_transaction_id = crablet_progress_cursor_xid(last_position);
UPDATE crablet_outbox_topic_progress SET last_transaction_id = crablet_progress_cursor_xid(last_position);

COMMENT ON COLUMN crablet_view_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are processed next.';
COMMENT ON COLUMN crablet_automation_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are processed next.';
COMMENT ON COLUMN crablet_outbox_topic_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are published next.';
