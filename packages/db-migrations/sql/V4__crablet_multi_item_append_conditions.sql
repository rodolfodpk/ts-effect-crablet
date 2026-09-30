-- Append conditions with real multi-item semantics.
--
-- V1's append_events_if() took ONE flat (event types, tags) pair per condition. A Query is an OR of
-- items, each item being (any-of event types) AND (all tags); flattening the items into one pair
-- turned that OR into an AND across every item's tags, so a conflicting event matching just one item
-- was never detected. This version takes the condition as a JSONB array of items:
--
--     [{"types": ["A","B"], "tags": ["k=v","k2=v2"]}, {"types": [], "tags": ["k3=v3"]}]
--
-- An event matches an item when (types is empty OR event type is one of types) AND (event tags
-- contain all of tags). It matches the condition when it matches ANY item.
--
-- Two other changes to the conflict check:
--
--  * V1 also required `transaction_id < pg_snapshot_xmin(pg_current_snapshot())`. xmin is the oldest
--    still-running transaction, so while ANY unrelated transaction was open, every event committed
--    after it started was excluded from the check and conflicts went undetected. MVCC already hides
--    uncommitted peer rows, and the advisory locks below make committed peers visible (a fresh READ
--    COMMITTED snapshot is taken by the statement that runs after the locks), so the filter is
--    unnecessary and harmful. Callers must therefore run at READ COMMITTED (the Postgres default).
--
--  * Locks are taken per ITEM (sorted, so acquisition order is deadlock-free), not per whole
--    condition: two commands whose conditions share an identical item now serialize on it even when
--    their other items differ (e.g. a withdrawal on wallet A and a transfer from A to B).
--    Idempotency locks are taken before concurrency locks, always in that order.

DROP FUNCTION IF EXISTS append_events_if(
    TEXT[], TEXT[], JSONB[], TEXT[], TEXT[], BIGINT, TEXT[], TEXT[],
    TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT
);

-- Stable, sorted, de-duplicated advisory-lock keys, one per item.
CREATE OR REPLACE FUNCTION crablet_item_lock_keys(p_items JSONB, p_prefix TEXT)
    RETURNS BIGINT[] AS
$$
SELECT COALESCE(array_agg(s.k ORDER BY s.k), ARRAY []::BIGINT[])
FROM (SELECT DISTINCT hashtextextended(
                              p_prefix
                                  || 'types=' || COALESCE((SELECT string_agg(t, ',' ORDER BY t)
                                                           FROM jsonb_array_elements_text(item.value -> 'types') AS t), '')
                                  || '|tags=' || COALESCE((SELECT string_agg(t, ',' ORDER BY t)
                                                           FROM jsonb_array_elements_text(item.value -> 'tags') AS t), ''),
                              0) AS k
      FROM jsonb_array_elements(p_items) AS item(value)) s
$$ LANGUAGE sql IMMUTABLE;

-- True when any event after p_after_position (NULL = from the start) matches any item.
-- Loops over items so each per-item query is planned with concrete parameters and can use the
-- GIN index on crablet_events.tags.
CREATE OR REPLACE FUNCTION crablet_items_match_any(p_items JSONB, p_after_position BIGINT)
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
                       WHERE (p_after_position IS NULL OR e.position > p_after_position)
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
    v_lock_key      BIGINT;
BEGIN
    IF v_has_idem THEN
        FOREACH v_lock_key IN ARRAY crablet_item_lock_keys(p_idempotency_items, 'idempotency_item:')
            LOOP
                PERFORM pg_advisory_xact_lock(v_lock_key);
            END LOOP;
    END IF;

    IF v_has_conc THEN
        FOREACH v_lock_key IN ARRAY crablet_item_lock_keys(p_concurrency_items, 'concurrency_item:')
            LOOP
                PERFORM pg_advisory_xact_lock(v_lock_key);
            END LOOP;
    END IF;

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

    PERFORM append_events_batch(
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
            'transaction_id', pg_current_xact_id()::TEXT
           );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after '
    'p_after_cursor_position (p_concurrency_items) exists. Conditions are JSONB arrays of '
    '{types, tags} items, OR-ed together. Serialized per item with pg_advisory_xact_lock; requires '
    'READ COMMITTED. Optionally notifies append listeners on commit.';
