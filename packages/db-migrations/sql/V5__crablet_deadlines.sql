-- Deadlines (ADR-0043, ADR-0047): a command to run once a time has passed.
--
-- A deadline is an event, `crablet.DeadlineScheduled { command, input, dueAt }`, and its firing is one too (`crablet.DeadlineFired`, caused by it).
-- `crablet_deadlines` is an index of the pending ones by due time: the append that stores a deadline writes its row in the same statement (so a deadline
-- is pending from the instant its decision commits, whoever appended it), and the firing deletes it. It holds the position and the due time only; the
-- command and the input stay in the event. It can be rebuilt from the log:
--
--   TRUNCATE crablet_deadlines;
--   INSERT INTO crablet_deadlines (deadline_position, due_at)
--   SELECT s.position, (s.data ->> 'dueAt')::timestamptz FROM crablet_events s
--   WHERE s.type = 'crablet.DeadlineScheduled'
--     AND NOT EXISTS (SELECT 1 FROM crablet_events f WHERE f.type = 'crablet.DeadlineFired' AND f.causation_id = s.position);

CREATE TABLE crablet_deadlines
(
    deadline_position BIGINT                   NOT NULL PRIMARY KEY,
    due_at            TIMESTAMP WITH TIME ZONE NOT NULL
);

-- The processor's one read: the due ones, in due order.
CREATE INDEX idx_crablet_deadlines_due ON crablet_deadlines (due_at, deadline_position);

COMMENT ON TABLE crablet_deadlines IS
    'Pending deadlines (crablet.DeadlineScheduled events not yet fired), by due time. Written by append_events_batch, deleted when the deadline fires; rebuildable from the log.';

-- The deadlines processor's status, error count and registration. Its cursor columns are kept for the shared progress tracker and never move: what is
-- left to fire is the rows of crablet_deadlines, not a position in the log.
CREATE TABLE crablet_deadline_progress
(
    processor_name      TEXT                     PRIMARY KEY,
    instance_id         TEXT,
    status              TEXT                     NOT NULL DEFAULT 'ACTIVE',
    last_position       BIGINT                   NOT NULL DEFAULT 0,
    last_transaction_id XID8                     NOT NULL DEFAULT '0',
    error_count         INTEGER                  NOT NULL DEFAULT 0,
    last_error          TEXT,
    last_error_at       TIMESTAMP WITH TIME ZONE,
    last_updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_crablet_deadline_status CHECK (status IN ('ACTIVE', 'PAUSED', 'FAILED')),
    CONSTRAINT chk_crablet_deadline_name_len CHECK (length(processor_name) <= 256),
    CONSTRAINT chk_crablet_deadline_instance_len CHECK (instance_id IS NULL OR length(instance_id) <= 256)
);
