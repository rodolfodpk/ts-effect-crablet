-- The position of the last appended event is returned to the caller.
--
-- A caller that wants to "read its own write" from an asynchronous projection (a view) needs the log
-- position its append reached, so it can wait until that view's progress has passed it. Until now
-- append_events_if() returned only the transaction id. append_events_batch() now returns the highest
-- position it inserted (events are inserted in order, so that is the last event's position), and
-- append_events_if() passes it on as `last_position` in its JSONB result. Nothing is stored differently.

DROP FUNCTION IF EXISTS append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT);

CREATE FUNCTION append_events_batch(
    p_types          TEXT[],
    p_tags           TEXT[],
    p_data           JSONB[],
    p_occurred_at    TIMESTAMP WITH TIME ZONE,
    p_correlation_id UUID   DEFAULT NULL,
    p_causation_id   BIGINT DEFAULT NULL
) RETURNS BIGINT AS
$$
DECLARE
    v_last_position BIGINT;
BEGIN
    WITH inserted AS (
        INSERT INTO crablet_events (type, tags, data, transaction_id, occurred_at,
                                    correlation_id, causation_id)
            SELECT t.type,
                   t.tag_string::TEXT[],
                   t.data,
                   pg_current_xact_id(),
                   p_occurred_at,
                   p_correlation_id,
                   p_causation_id
            FROM UNNEST($1, $2, $3) AS t(type, tag_string, data)
            RETURNING position, tags),
         tagged AS (
             INSERT INTO crablet_event_tags (position, key, value)
                 SELECT i.position,
                        split_part(tag, '=', 1)                      AS key,
                        substring(tag FROM position('=' IN tag) + 1) AS value
                 FROM inserted i,
                      LATERAL unnest(i.tags) AS tag
                 WHERE tag LIKE '%=%')
    SELECT max(position) INTO v_last_position FROM inserted;
    RETURN v_last_position;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT) IS
    'Inserts events (and their key/value tag rows) and returns the position of the last one.';

CREATE OR REPLACE FUNCTION append_events_if(
    p_types                 TEXT[],
    p_tags                  TEXT[],
    p_data                  JSONB[],
    p_concurrency_items     JSONB                    DEFAULT NULL,
    p_after_cursor_position BIGINT                   DEFAULT NULL,
    p_idempotency_items     JSONB                    DEFAULT NULL,
    p_occurred_at           TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_correlation_id        UUID                     DEFAULT NULL,
    p_causation_id          BIGINT                   DEFAULT NULL,
    p_notify_channel        TEXT                     DEFAULT NULL,
    p_notify_payload        TEXT                     DEFAULT NULL
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
        v_has_duplicate := crablet_items_match_any(p_idempotency_items, NULL);
    END IF;

    IF v_has_conc AND NOT v_has_duplicate THEN
        v_has_conflict := crablet_items_match_any(p_concurrency_items, p_after_cursor_position);
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

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after '
    'p_after_cursor_position (p_concurrency_items) exists. Conditions are JSONB arrays of '
    '{types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' (type, tag) pairs with pg_advisory_xact_lock; requires '
    'READ COMMITTED. Optionally notifies append listeners on commit.';
