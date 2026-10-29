-- The append's conflict is what the read could not see (ADR-0048).
--
-- A condition's cursor is the last SETTLED event its read loaded (ADR-0012): one whose transaction id is below the oldest one still running. While any
-- transaction in the database stays open, everything written after it is unsettled, sits above the cursor, and was counted as a conflict, though the
-- read had seen it: a long transaction anywhere made commands over recent events fail. The read now also passes the snapshot it was taken in
-- (p_after_snapshot, from pg_current_snapshot() just before it); a matching event after the cursor is a conflict only if that snapshot could not see it.
-- An event committed after the read was running or not started when the snapshot was taken, so it is still one: no conflict is lost. Without a
-- snapshot, the check is as before.
--
-- Only the check changes: append_events_if and crablet_items_match_any take the snapshot as a last parameter, with a default, so a call without it
-- resolves to them and keeps the old check. The functions are dropped and created again (a new parameter is a new signature); their bodies are V2's,
-- with the snapshot added. append_events_batch and the lock helpers stay in V2.

DROP FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA);
DROP FUNCTION crablet_items_match_any(JSONB, BIGINT, XID8);

-- True when any event after the cursor matches any item. The cursor is (p_after_xid, p_after_position) in
-- (transaction_id, position) order; with p_after_xid NULL it is position-only; with p_after_position NULL
-- there is no cursor (the start of the log). With p_after_snapshot, an event that snapshot could see does not count.
CREATE FUNCTION crablet_items_match_any(p_items JSONB, p_after_position BIGINT, p_after_xid XID8, p_after_snapshot PG_SNAPSHOT DEFAULT NULL)
    RETURNS BOOLEAN AS
$$
DECLARE
    v_item  JSONB;
    v_types TEXT[];
    v_tags  TEXT[];
    -- The snapshot's running transactions, read once: with the snapshot, only these and the ones from its xmax on are candidates.
    v_xip   XID8[] := CASE WHEN p_after_snapshot IS NULL THEN NULL ELSE ARRAY(SELECT pg_snapshot_xip(p_after_snapshot)) END;
BEGIN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
        LOOP
            v_types := ARRAY(SELECT jsonb_array_elements_text(v_item -> 'types'));
            v_tags := ARRAY(SELECT jsonb_array_elements_text(v_item -> 'tags'));
            IF EXISTS (SELECT 1
                       FROM crablet_events e
                       WHERE (p_after_position IS NULL
                           OR (p_after_xid IS NULL AND e.position > p_after_position)
                           OR (p_after_xid IS NOT NULL AND (e.transaction_id, e.position) > (p_after_xid, p_after_position)))
                         -- The caller's own earlier appends (a command's `prepare`) were part of what it loaded; they
                         -- are not settled, so they sit above the cursor, but they are not a concurrent change.
                         AND (p_after_xid IS NULL OR e.transaction_id IS DISTINCT FROM pg_current_xact_id_if_assigned())
                         -- An event the read could see is not a change since the read, settled or not (ADR-0048). Not visible in the snapshot =
                         -- from its xmax on, or running when it was taken: NOT pg_visible_in_snapshot, written so the scan skips the visible ones.
                         AND (p_after_snapshot IS NULL
                           OR e.transaction_id >= pg_snapshot_xmax(p_after_snapshot)
                           OR e.transaction_id = ANY (v_xip))
                         AND (cardinality(v_types) = 0 OR e.type = ANY (v_types))
                         AND (cardinality(v_tags) = 0 OR e.tags @> v_tags)
                       LIMIT 1) THEN
                RETURN TRUE;
            END IF;
        END LOOP;
    RETURN FALSE;
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
    p_after_snapshot               PG_SNAPSHOT              DEFAULT NULL
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

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA, PG_SNAPSHOT) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor (p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists; with p_after_snapshot, an event that snapshot (the read''s) could see is not a conflict. Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' (type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. With p_require_fresh_transaction, refuses (CRB01) a transaction that has already written. Stores p_request_fingerprint on the events; a duplicate reports what it matched (crablet_items_duplicate).';
