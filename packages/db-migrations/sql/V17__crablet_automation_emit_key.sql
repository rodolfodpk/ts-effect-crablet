-- The same trigger cannot append the same request twice (ADR-0035).
--
-- An automation's command is protected by its idempotency query (`idempotentBy`), which its author writes. A query that never matches what the command
-- appends (a misspelled tag, the wrong event type) does nothing, and a redelivered trigger - a crash between the command and the cursor, a zombie leader
-- and its successor - does the work again. This is the database's backstop: an append made under a cause (the trigger's position) stores an emit key
-- (the request's fingerprint and the event's place in the append), unique per cause. A second append of the same request for the same trigger hits the
-- index and is reported as a duplicate ("by_trigger"), whatever the query said. The key is the request's content, not the decision's index, so a
-- redelivery whose decide returns more or other decisions still appends what is new.

ALTER TABLE crablet_events ADD COLUMN emit_key TEXT;

COMMENT ON COLUMN crablet_events.emit_key IS
    'For an event appended under a cause (an automation trigger): the request fingerprint and the event''s place in its append. Unique per cause.';

CREATE UNIQUE INDEX idx_crablet_events_emit_key ON crablet_events (causation_id, emit_key) WHERE emit_key IS NOT NULL;

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
            RETURNING position, tags),
         tagged AS (
             INSERT INTO crablet_event_tag_keys (key, position)
                 SELECT DISTINCT split_part(tag, '=', 1), i.position
                 FROM inserted i,
                      LATERAL unnest(i.tags) AS tag
                 WHERE tag LIKE '%=%')
    SELECT max(position) INTO v_last_position FROM inserted;
    RETURN v_last_position;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION append_events_if(
    p_types                        TEXT[],
    p_tags                         TEXT[],
    p_data                         JSONB[],
    p_concurrency_items            JSONB                    DEFAULT NULL,
    p_after_cursor_position        BIGINT                   DEFAULT NULL,
    p_idempotency_items            JSONB                    DEFAULT NULL,
    p_occurred_at                  TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_correlation_id               UUID                     DEFAULT NULL,
    p_causation_id                 BIGINT                   DEFAULT NULL,
    p_notify_channel               TEXT                     DEFAULT NULL,
    p_notify_payload               TEXT                     DEFAULT NULL,
    p_after_cursor_transaction_id  XID8                     DEFAULT NULL,
    p_require_fresh_transaction    BOOLEAN                  DEFAULT FALSE,
    p_request_fingerprint          BYTEA                    DEFAULT NULL
) RETURNS JSONB AS
$$
DECLARE
    v_has_duplicate BOOLEAN := FALSE;
    v_has_conflict  BOOLEAN := FALSE;
    v_has_idem      BOOLEAN := p_idempotency_items IS NOT NULL AND jsonb_array_length(p_idempotency_items) > 0;
    v_has_conc      BOOLEAN := p_concurrency_items IS NOT NULL AND jsonb_array_length(p_concurrency_items) > 0;
    v_lock          RECORD;
    v_last_position BIGINT;
    v_constraint    TEXT;
BEGIN
    -- A command's append must be its transaction's first write (ADR-0033).
    IF p_require_fresh_transaction AND pg_current_xact_id_if_assigned() IS NOT NULL THEN
        RAISE EXCEPTION 'a command must not run in a transaction that has already written: its events could be delivered before the events it read (ADR-0033)'
            USING ERRCODE = 'CRB01';
    END IF;

    -- Take every lock first, in one globally sorted order (see crablet_writer_lock_keys).
    FOR v_lock IN SELECT k, excl FROM crablet_writer_lock_keys(p_types, p_tags, p_concurrency_items, p_idempotency_items) ORDER BY k
        LOOP
            IF v_lock.excl THEN
                PERFORM pg_advisory_xact_lock(v_lock.k);
            ELSE
                PERFORM pg_advisory_xact_lock_shared(v_lock.k);
            END IF;
        END LOOP;

    -- Checks run in statements AFTER the locks above, so under READ COMMITTED they see every
    -- transaction that committed while we waited for a lock.
    IF v_has_idem THEN
        v_has_duplicate := crablet_items_match_any(p_idempotency_items, NULL, NULL);
    END IF;

    IF v_has_conc AND NOT v_has_duplicate THEN
        v_has_conflict := crablet_items_match_any(p_concurrency_items, p_after_cursor_position, p_after_cursor_transaction_id);
    END IF;

    IF v_has_duplicate THEN
        -- What the key matched, so the caller can answer with the earlier write's marker and tell the same request from another (ADR-0034).
        RETURN jsonb_build_object(
                'success', false,
                'message', 'duplicate operation detected',
                'error_code', 'IDEMPOTENCY_VIOLATION',
                'duplicate', crablet_items_duplicate(p_idempotency_items)
               );
    END IF;

    IF v_has_conflict THEN
        RETURN jsonb_build_object(
                'success', false,
                'message', 'append condition violated',
                'error_code', 'DCB_VIOLATION'
               );
    END IF;

    IF p_causation_id IS NOT NULL AND p_request_fingerprint IS NOT NULL THEN
        -- Under a cause (an automation's trigger) the events carry an emit key, unique per cause: the same trigger cannot append the same request twice,
        -- whatever its idempotency query says (ADR-0035). Two deliveries racing: the second waits for the first's commit, then hits the index.
        BEGIN
            v_last_position := append_events_batch(
                    p_types,
                    p_tags,
                    p_data,
                    COALESCE(p_occurred_at, CURRENT_TIMESTAMP),
                    p_correlation_id,
                    p_causation_id,
                    p_request_fingerprint
                    );
        EXCEPTION
            WHEN unique_violation THEN
                GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
                IF v_constraint IS DISTINCT FROM 'idx_crablet_events_emit_key' THEN
                    RAISE;
                END IF;
                RETURN jsonb_build_object(
                        'success', false,
                        'message', 'this trigger already appended this request',
                        'error_code', 'IDEMPOTENCY_VIOLATION',
                        'duplicate', (SELECT jsonb_build_object(
                                                     'latest_transaction_id', e.transaction_id::TEXT,
                                                     'latest_position', e.position::TEXT,
                                                     'by_trigger', TRUE,
                                                     'requests', jsonb_build_array(jsonb_build_object('fingerprint', encode(e.request_fingerprint, 'hex'), 'causation_id', e.causation_id::TEXT)))
                                      FROM crablet_events e
                                      WHERE e.causation_id = p_causation_id
                                        AND e.emit_key LIKE encode(p_request_fingerprint, 'hex') || '/%'
                                      ORDER BY e.transaction_id DESC, e.position DESC
                                      LIMIT 1)
                       );
        END;
    ELSE
        v_last_position := append_events_batch(
                p_types,
                p_tags,
                p_data,
                COALESCE(p_occurred_at, CURRENT_TIMESTAMP),
                p_correlation_id,
                p_causation_id,
                p_request_fingerprint
                );
    END IF;

    IF p_notify_channel IS NOT NULL THEN
        BEGIN
            PERFORM pg_notify(p_notify_channel, COALESCE(p_notify_payload, '*'));
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'pg_notify failed on channel %: %', p_notify_channel, SQLERRM;
        END;
    END IF;

    RETURN jsonb_build_object(
            'success', true,
            'message', 'events appended successfully',
            'events_count', array_length(p_types, 1),
            'last_position', v_last_position::TEXT,
            'transaction_id', pg_current_xact_id()::TEXT
           );
END;
$$ LANGUAGE plpgsql;
