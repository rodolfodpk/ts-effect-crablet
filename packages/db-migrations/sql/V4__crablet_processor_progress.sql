-- The processors' progress (ADR-0047: one file per part of the schema, in its final shape).
--
-- One row per processor: the views, the automations and the outbox's (topic, publisher) pairs. Each row is the processor's cursor and status. These
-- tables hold a handful of rows and are read by primary key, so they have no secondary index: an index would only block HOT updates, and every tick
-- writes last_updated_at or the heartbeat. The deadlines processor's row is in V5.
--
-- The cursor is a (transaction_id, position) pair (ADR-0012): position comes from nextval() and transaction_id is the xid of the inserting transaction,
-- and the two can be taken in opposite orders. A transaction with the lower xid and the higher position can commit while another (higher xid, lower
-- position) is still open; a poller that moved a bare position cursor past the second one's position would skip its event for ever. A cursor on
-- (transaction_id, position) cannot skip: every xid below the snapshot's xmin belongs to a finished transaction, and a row that appears later has an xid
-- at or above that xmin, so it sorts after every row already delivered. last_position also serves the lag display and operations.

CREATE TABLE crablet_outbox_topic_progress
(
    topic               TEXT                     NOT NULL,
    publisher           TEXT                     NOT NULL,
    last_position       BIGINT                   NOT NULL DEFAULT 0,
    last_published_at   TIMESTAMP WITH TIME ZONE,
    status              TEXT                     NOT NULL DEFAULT 'ACTIVE',
    error_count         INT                      NOT NULL DEFAULT 0,
    last_error          TEXT,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    leader_instance     TEXT,
    leader_since        TIMESTAMP WITH TIME ZONE,
    leader_heartbeat    TIMESTAMP WITH TIME ZONE,
    last_transaction_id XID8                     NOT NULL DEFAULT '0',

    CONSTRAINT pk_crablet_outbox_topic_progress PRIMARY KEY (topic, publisher),
    CONSTRAINT chk_crablet_outbox_status CHECK (status IN ('ACTIVE', 'PAUSED', 'FAILED')),
    CONSTRAINT chk_crablet_outbox_topic_len CHECK (length(topic) <= 128),
    CONSTRAINT chk_crablet_outbox_publisher_len CHECK (length(publisher) <= 128),
    CONSTRAINT chk_crablet_outbox_leader_instance_len CHECK (leader_instance IS NULL OR length(leader_instance) <= 256)
);

CREATE TABLE crablet_view_progress
(
    view_name           TEXT                     PRIMARY KEY,
    instance_id         TEXT,
    status              TEXT                     NOT NULL DEFAULT 'ACTIVE',
    last_position       BIGINT                   NOT NULL DEFAULT 0,
    error_count         INTEGER                  NOT NULL DEFAULT 0,
    last_error          TEXT,
    last_error_at       TIMESTAMP WITH TIME ZONE,
    last_updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_transaction_id XID8                     NOT NULL DEFAULT '0',
    CONSTRAINT chk_crablet_view_status CHECK (status IN ('ACTIVE', 'PAUSED', 'FAILED')),
    CONSTRAINT chk_crablet_view_name_len CHECK (length(view_name) <= 256),
    CONSTRAINT chk_crablet_view_instance_len CHECK (instance_id IS NULL OR length(instance_id) <= 256)
);

CREATE TABLE crablet_automation_progress
(
    automation_name     TEXT                     PRIMARY KEY,
    instance_id         TEXT,
    status              TEXT                     NOT NULL DEFAULT 'ACTIVE',
    last_position       BIGINT                   NOT NULL DEFAULT 0,
    error_count         INTEGER                  NOT NULL DEFAULT 0,
    last_error          TEXT,
    last_error_at       TIMESTAMP WITH TIME ZONE,
    last_updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_transaction_id XID8                     NOT NULL DEFAULT '0',
    CONSTRAINT chk_crablet_automation_status CHECK (status IN ('ACTIVE', 'PAUSED', 'FAILED')),
    CONSTRAINT chk_crablet_automation_name_len CHECK (length(automation_name) <= 256),
    CONSTRAINT chk_crablet_automation_instance_len CHECK (instance_id IS NULL OR length(instance_id) <= 256)
);

-- The transaction id half of the cursor for a progress row that only has a position (a row written before cursors were pairs, or restored from one).
-- A position-only cursor says "everything above last_position is undelivered", which includes an event with a LOWER xid but a HIGHER position than
-- the one at last_position (the very case above). So the xid is the smaller of the xid at last_position and the smallest xid among later events: it
-- may redeliver a few events (handlers are at-least-once), it never skips one.
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

COMMENT ON TABLE crablet_outbox_topic_progress IS
    'Tracks last published event position per publisher per topic. Each publisher advances independently through events matching its topic criteria.';

COMMENT ON COLUMN crablet_outbox_topic_progress.leader_instance IS
    'Hostname/pod name of the instance currently holding the lock for this topic-publisher pair.';

COMMENT ON COLUMN crablet_outbox_topic_progress.leader_since IS
    'When the current instance became the leader.';

COMMENT ON COLUMN crablet_outbox_topic_progress.leader_heartbeat IS
    'Last heartbeat timestamp from the leader instance. Used to detect abandoned pairs when leader crashes.';

COMMENT ON TABLE crablet_view_progress IS
    'Progress tracking for view projections. Each view tracks its own position independently.';

COMMENT ON COLUMN crablet_view_progress.view_name IS
    'Unique name of the view projection.';

COMMENT ON COLUMN crablet_view_progress.instance_id IS
    'Instance ID of the leader processing this view.';

COMMENT ON COLUMN crablet_view_progress.status IS
    'Status: ACTIVE, PAUSED, or FAILED.';

COMMENT ON COLUMN crablet_view_progress.last_position IS
    'Last processed event position. Events with position > last_position will be processed.';

COMMENT ON COLUMN crablet_view_progress.error_count IS
    'Number of consecutive errors. View is marked FAILED if it exceeds the configured threshold.';

COMMENT ON TABLE crablet_automation_progress IS
    'Progress tracking for event-driven automations. Each automation tracks its own position independently.';

COMMENT ON COLUMN crablet_automation_progress.automation_name IS
    'Unique name of the automation.';

COMMENT ON COLUMN crablet_automation_progress.instance_id IS
    'Instance ID of the leader processing this automation.';

COMMENT ON COLUMN crablet_automation_progress.status IS
    'Status: ACTIVE, PAUSED, or FAILED.';

COMMENT ON COLUMN crablet_automation_progress.last_position IS
    'Last processed event position. Events with position > last_position will be processed.';

COMMENT ON COLUMN crablet_automation_progress.error_count IS
    'Number of consecutive errors. Automation is marked FAILED if it exceeds the configured threshold.';

COMMENT ON COLUMN crablet_view_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are processed next.';
COMMENT ON COLUMN crablet_automation_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are processed next.';
COMMENT ON COLUMN crablet_outbox_topic_progress.last_transaction_id IS
    'Transaction id half of the progress cursor: events with (transaction_id, position) > (last_transaction_id, last_position) are published next.';
