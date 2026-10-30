-- The client's metadata on an event (ADR-0051).
--
-- The DCB specification lets an event carry metadata the client defines. It is a column of its own, apart from the payload (the domain's data) and
-- from what the store records itself (correlation_id, causation_id, request_fingerprint): a JSON object per event, or NULL. Nothing in the framework
-- reads it, and it is not queried by; what is to be selected by goes in a tag.
--
-- The append takes it as one more array, parallel to the types, tags and payloads (p_metadata, with a default: a call without it stores none).
-- append_events_batch and append_events_if are dropped and created again (a new parameter is a new signature), with their last bodies (V2, V6) and the
-- metadata added; crablet_items_match_any stays in V6 and the lock helpers in V2.

ALTER TABLE crablet_events ADD COLUMN metadata JSONB;

COMMENT ON COLUMN crablet_events.metadata IS
    'The client''s metadata on the event (a JSON object), or NULL. Recorded, never read by the framework, not queried by (ADR-0051).';

DROP FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA, PG_SNAPSHOT);
DROP FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT, BYTEA);

CREATE FUNCTION append_events_batch(
    p_types               TEXT[],
    p_tags                TEXT[],
    p_data                JSONB[],
    p_occurred_at         TIMESTAMP WITH TIME ZONE,
    p_correlation_id      UUID   DEFAULT NULL,
    p_causation_id        BIGINT DEFAULT NULL,
    p_request_fingerprint BYTEA  DEFAULT NULL,
    p_metadata            JSONB[] DEFAULT NULL
) RETURNS BIGINT AS
$$
DECLARE
    v_last_position BIGINT;
BEGIN
    WITH inserted AS (
        INSERT INTO crablet_events (type, tags, data, transaction_id, occurred_at,
                                    correlation_id, causation_id, request_fingerprint, emit_key, metadata)
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
                        THEN encode(p_request_fingerprint, 'hex') || '/' || t.ord END,
                   -- the client's metadata for the event, or none (ADR-0051); without p_metadata every event has none
                   t.metadata
            FROM UNNEST(p_types, p_tags, p_data, p_metadata) WITH ORDINALITY AS t(type, tag_string, data, metadata, ord)
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

CREATE FUNCTION append_events_if(
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
    p_request_fingerprint          BYTEA                    DEFAULT NULL,
    p_after_snapshot               PG_SNAPSHOT              DEFAULT NULL,
    p_metadata                     JSONB[]                  DEFAULT NULL
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
        v_has_conflict := crablet_items_match_any(p_concurrency_items, p_after_cursor_position, p_after_cursor_transaction_id, p_after_snapshot);
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
                    p_request_fingerprint,
                    p_metadata
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
                p_request_fingerprint,
                p_metadata
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

COMMENT ON FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT, BYTEA, JSONB[]) IS
    'Inserts events (and one row per tag KEY of each in crablet_event_tag_keys), with the request fingerprint and the metadata of each if given, and returns the position of the last one.';

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA, PG_SNAPSHOT, JSONB[]) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor (p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists; with p_after_snapshot, an event that snapshot (the read''s) could see is not a conflict. Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' (type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. With p_require_fresh_transaction, refuses (CRB01) a transaction that has already written. Stores p_request_fingerprint and p_metadata (one per event) on the events; a duplicate reports what it matched (crablet_items_duplicate).';
