-- The append condition's cursor becomes a (transaction_id, position) pair.
--
-- append_events_if() used to refuse an append when a matching event had `position > p_after_cursor_position`,
-- where the cursor was the position of the last event the command's model had loaded. But `position` comes
-- from nextval() and `transaction_id` is the xid of the inserting transaction, and the two can be taken in
-- opposite orders: writer T1 (lower xid, higher position) can commit while writer T2 (higher xid, lower
-- position) is still open. A command that loads in between sees T1's event, takes T1's position as its
-- cursor, and when T2's event then commits at a LOWER position the check cannot see it: a lost conflict.
-- (Writers of events of different TYPES do not share a (type, tag) lock, so a boundary that spans several
-- event types - the usual shape of a decision model - is exposed to this.)
--
-- A keyset on (transaction_id, position) is safe: the model load now returns, as its cursor, the pair of the
-- last loaded event that was already SETTLED when it read (xid below the snapshot's xmin, so its transaction
-- had finished). Everything that becomes visible afterwards has an xid at or above that xmin and so sorts
-- after the cursor. Events the load saw but that were not yet settled are reported as a conflict (the
-- command is retried and reloads them, by then settled): never a missed one.
--
-- The caller's own transaction is ignored by the concurrency check (see crablet_items_match_any).
--
-- p_after_cursor_transaction_id is optional: NULL keeps the old position-only comparison.

DROP FUNCTION IF EXISTS append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS crablet_items_match_any(JSONB, BIGINT);

-- True when any event after the cursor matches any item. The cursor is (p_after_xid, p_after_position) in
-- (transaction_id, position) order; with p_after_xid NULL it is position-only; with p_after_position NULL
-- there is no cursor (the start of the log).
CREATE OR REPLACE FUNCTION crablet_items_match_any(p_items JSONB, p_after_position BIGINT, p_after_xid XID8)
    RETURNS BOOLEAN AS
$$
DECLARE
    v_item  JSONB;
    v_types TEXT[];
    v_tags  TEXT[];
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
                         AND (cardinality(v_types) = 0 OR e.type = ANY (v_types))
                         AND (cardinality(v_tags) = 0 OR e.tags @> v_tags)
                       LIMIT 1) THEN
                RETURN TRUE;
            END IF;
        END LOOP;
    RETURN FALSE;
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
    p_after_cursor_transaction_id  XID8                     DEFAULT NULL
) RETURNS JSONB AS
$$
DECLARE
    v_has_duplicate BOOLEAN := FALSE;
    v_has_conflict  BOOLEAN := FALSE;
    v_has_idem      BOOLEAN := p_idempotency_items IS NOT NULL AND jsonb_array_length(p_idempotency_items) > 0;
    v_has_conc      BOOLEAN := p_concurrency_items IS NOT NULL AND jsonb_array_length(p_concurrency_items) > 0;
    v_lock          RECORD;
    v_last_position BIGINT;
BEGIN
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
        RETURN jsonb_build_object(
                'success', false,
                'message', 'duplicate operation detected',
                'error_code', 'IDEMPOTENCY_VIOLATION'
               );
    END IF;

    IF v_has_conflict THEN
        RETURN jsonb_build_object(
                'success', false,
                'message', 'append condition violated',
                'error_code', 'DCB_VIOLATION'
               );
    END IF;

    v_last_position := append_events_batch(
            p_types,
            p_tags,
            p_data,
            COALESCE(p_occurred_at, CURRENT_TIMESTAMP),
            p_correlation_id,
            p_causation_id
            );

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

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor '
    '(p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists. '
    'Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' '
    '(type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. Optionally notifies append listeners on commit.';
