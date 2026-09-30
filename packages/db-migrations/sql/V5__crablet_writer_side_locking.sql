-- Writer-side locking: an in-flight writer makes every checker whose condition its events match wait.
--
-- V4 locked only the items of an append's CONDITION, keyed by the whole item. Two writers serialized only
-- when they held a textually identical item. An append with no condition (or one whose items differ) took
-- no lock that a checker could collide with, so its event could commit between the checker's "nothing
-- matches since position p" check and the checker's own insert: the checker decided without an event that
-- was already going to match its boundary, and both committed (a lost conflict).
--
-- The fix is to lock by (event type, tag) pairs, taken by EVERY writer for its own events as well as for its
-- conditions. An event that matches a condition item carries all of the item's tags and has one of its
-- types, so it shares at least one (type, tag) pair with that item - which means a writer and a checker that
-- could ever interfere always queue on the same lock, and the checker's check (run after the locks, in a
-- fresh READ COMMITTED statement) sees everything that committed while it waited.
--
--   exclusive "L:type|tag"  - per (type, tag) pair of the events appended and of every condition item
--   shared    "T:type"      - per event type appended; EXCLUSIVE for a condition item with types but no tags
--   shared    "G"           - every writer; EXCLUSIVE for a condition item with no types (matches any type)
--
-- Checkers with a tag-less or type-less item therefore still serialize against every writer they could
-- conflict with, at the price of waiting for all of them. Idempotency items are locked exactly like
-- concurrency items (an idempotency hit is checked first, after the locks).
--
-- All locks are taken in one statement-independent loop ordered by key, so two appends never acquire the
-- same keys in opposite order. Transactions that make several appends (a command's `prepare` appends and
-- then its own append) can still deadlock with each other; Postgres detects that (SQLSTATE 40P01) and the
-- command executor retries it like a conflict.
--
-- Cost: writers of the same (type, tag) queue, even when their decisions do not conflict (for example two
-- concurrent deposits to one wallet). Appends take more locks than in V4.

DROP FUNCTION IF EXISTS crablet_item_lock_keys(JSONB, TEXT);

CREATE OR REPLACE FUNCTION crablet_leaf_lock_key(p_type TEXT, p_tag TEXT) RETURNS BIGINT AS
$$
SELECT hashtextextended('L:' || p_type || '|' || p_tag, 0)
$$ LANGUAGE sql IMMUTABLE;

-- The (key, exclusive?) pairs an append must hold: one row per distinct key, exclusive if any use is.
CREATE OR REPLACE FUNCTION crablet_writer_lock_keys(
    p_types             TEXT[],
    p_tags              TEXT[],
    p_concurrency_items JSONB,
    p_idempotency_items JSONB
) RETURNS TABLE (k BIGINT, excl BOOLEAN) AS
$$
WITH event_rows AS (SELECT p_types[i] AS type, p_tags[i]::TEXT[] AS tags
                    FROM generate_subscripts(p_types, 1) AS i),
     items AS (SELECT item.value AS item
               FROM jsonb_array_elements(COALESCE(p_concurrency_items, '[]'::JSONB)) AS item(value)
               UNION ALL
               SELECT item.value
               FROM jsonb_array_elements(COALESCE(p_idempotency_items, '[]'::JSONB)) AS item(value)),
     item_shapes AS (SELECT ARRAY(SELECT jsonb_array_elements_text(item -> 'types')) AS types,
                            ARRAY(SELECT jsonb_array_elements_text(item -> 'tags'))  AS tags
                     FROM items),
     wanted AS (
         -- events: exclusive on each (type, tag); shared on the type and on the global key
         SELECT crablet_leaf_lock_key(e.type, tag) AS k, TRUE AS excl
         FROM event_rows e, LATERAL unnest(e.tags) AS tag
         UNION ALL
         SELECT hashtextextended('T:' || e.type, 0), FALSE FROM event_rows e
         UNION ALL
         SELECT hashtextextended('G', 0), FALSE WHERE cardinality(p_types) > 0
         UNION ALL
         -- items with types and tags: exclusive on each (type, tag)
         SELECT crablet_leaf_lock_key(type, tag), TRUE
         FROM item_shapes s, LATERAL unnest(s.types) AS type, LATERAL unnest(s.tags) AS tag
         WHERE cardinality(s.types) > 0 AND cardinality(s.tags) > 0
         UNION ALL
         -- items with types but no tags: exclusive on the type (writers hold it shared)
         SELECT hashtextextended('T:' || type, 0), TRUE
         FROM item_shapes s, LATERAL unnest(s.types) AS type
         WHERE cardinality(s.types) > 0 AND cardinality(s.tags) = 0
         UNION ALL
         -- items with no types: exclusive on the global key (every writer holds it shared)
         SELECT hashtextextended('G', 0), TRUE
         FROM item_shapes s
         WHERE cardinality(s.types) = 0)
SELECT w.k, bool_or(w.excl) AS excl
FROM wanted w
GROUP BY w.k
$$ LANGUAGE sql STABLE;

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
    '{types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' (type, tag) pairs with pg_advisory_xact_lock; requires '
    'READ COMMITTED. Optionally notifies append listeners on commit.';
