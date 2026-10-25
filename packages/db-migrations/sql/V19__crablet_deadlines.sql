-- Deadlines (ADR-0043): a command to run once a time has passed.
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

-- V17's function, with one more statement: the deadlines among the inserted events get their row. For an append with no deadline it is a filter over
-- the rows just inserted, and touches no other table.
CREATE OR REPLACE FUNCTION append_events_batch(
    p_types               TEXT[],
    p_tags                TEXT[],
    p_data                JSONB[],
    p_occurred_at         TIMESTAMP WITH TIME ZONE,
    p_correlation_id      UUID   DEFAULT NULL,
    p_causation_id        BIGINT DEFAULT NULL,
    p_request_fingerprint BYTEA  DEFAULT NULL
) RETURNS BIGINT AS
$$
DECLARE
    v_last_position BIGINT;
BEGIN
    WITH inserted AS (
        INSERT INTO crablet_events (type, tags, data, transaction_id, occurred_at,
                                    correlation_id, causation_id, request_fingerprint, emit_key)
            SELECT t.type,
                   t.tag_string::TEXT[],
                   t.data,
                   pg_current_xact_id(),
                   p_occurred_at,
                   p_correlation_id,
                   p_causation_id,
                   p_request_fingerprint,
                   -- the request and the event's place in it, for an append made under a cause (ADR-0035)
                   CASE WHEN p_causation_id IS NOT NULL AND p_request_fingerprint IS NOT NULL
                        THEN encode(p_request_fingerprint, 'hex') || '/' || t.ord END
            FROM UNNEST($1, $2, $3) WITH ORDINALITY AS t(type, tag_string, data, ord)
            RETURNING position, tags, type, data),
         tagged AS (
             INSERT INTO crablet_event_tag_keys (key, position)
                 SELECT DISTINCT split_part(tag, '=', 1), i.position
                 FROM inserted i,
                      LATERAL unnest(i.tags) AS tag
                 WHERE tag LIKE '%=%'),
         deadlines AS (
             INSERT INTO crablet_deadlines (deadline_position, due_at)
                 SELECT i.position, (i.data ->> 'dueAt')::timestamptz
                 FROM inserted i
                 WHERE i.type = 'crablet.DeadlineScheduled')
    SELECT max(position) INTO v_last_position FROM inserted;
    RETURN v_last_position;
END;
$$ LANGUAGE plpgsql;
