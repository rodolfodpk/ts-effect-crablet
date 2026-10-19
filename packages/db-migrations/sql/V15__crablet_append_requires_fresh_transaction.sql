-- A command's append can require a transaction that has written nothing yet (ADR-0033).
--
-- Pollers deliver events in (transaction_id, position) order. That order follows causality - an event is delivered after every event the decision that
-- appended it had read - as long as the appending transaction got its transaction id AFTER it read. A transaction id is assigned at the first write, so
-- that holds when the append is the transaction's first write. The command executor asks for it with p_require_fresh_transaction; the function refuses
-- (SQLSTATE CRB01) a transaction that already has an id. A raw append leaves the flag off and is not checked.

DROP FUNCTION IF EXISTS append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8);

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
    p_require_fresh_transaction    BOOLEAN                  DEFAULT FALSE
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
    -- A command's events must be delivered after every event its decision read. Delivery follows (transaction_id, position), and a transaction id is
    -- assigned at a transaction's first write: if that first write is this append, it comes after the model was read, so every event read has a smaller
    -- transaction id. A transaction that already wrote got its id earlier, possibly before an event it then read had committed, and its events could be
    -- delivered before their cause. Advisory locks do not assign a transaction id, so this check can come first. (ADR-0033)
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

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor '
    '(p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists. '
    'Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' '
    '(type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. With p_require_fresh_transaction, refuses (CRB01) a transaction '
    'that has already written, so the events sort after everything the caller read. Optionally notifies append listeners on commit.';
