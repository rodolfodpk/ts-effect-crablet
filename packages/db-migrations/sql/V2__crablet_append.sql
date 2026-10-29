-- The conditional append (ADR-0047: one file per part of the schema, in its final shape).
--
-- append_events_if is the one way the framework writes events: it checks the append's conditions and inserts its events in one statement, so the
-- check and the write cannot be separated (ADR-0003). Two conditions, both JSONB arrays of {types, tags} items, OR-ed together; an item matches an
-- event whose type is one of its types AND that carries all of its tags (the DCB specification's query):
--
--   - idempotency (p_idempotency_items): any match at all is a duplicate. What it matched is reported (crablet_items_duplicate), so the caller can
--     answer with the earlier write's marker and tell the same request (the same fingerprint) from another one under the same key (ADR-0034).
--   - concurrency (p_concurrency_items): a match AFTER the cursor is a conflict. The cursor is a (transaction_id, position) pair (ADR-0012): a sequence
--     value and a transaction id can be taken in opposite orders, so "after position N" alone could miss an event that commits later with a lower
--     position. The caller's own transaction is not a conflict for itself (crablet_items_match_any).
--
-- Writer-side locking (ADR-0003): every writer locks the (event type, tag) pairs of its own events as well as of its conditions, so a writer and a
-- checker that could interfere always queue on the same lock, and the checks, run after the locks in fresh READ COMMITTED statements, see everything
-- that committed while they waited:
--
--   exclusive "L:type|tag"  - per (type, tag) pair of the events appended and of every condition item
--   shared    "T:type"      - per event type appended; EXCLUSIVE for a condition item with types but no tags
--   shared    "G"           - every writer; EXCLUSIVE for a condition item with no types (matches any type)
--
-- All locks are taken in one loop ordered by key, so two appends never take the same keys in opposite order. Transactions that append more than once
-- can still deadlock with each other; Postgres detects it (SQLSTATE 40P01) and the command executor retries it like a conflict. The price: writers of
-- the same (type, tag) queue, even when their decisions do not conflict.
--
-- A command's append must be its transaction's first write (p_require_fresh_transaction, ADR-0033): otherwise its events could be delivered before the
-- events it read. It is refused with SQLSTATE CRB01.
--
-- Under a cause (an automation's trigger, p_causation_id with a fingerprint) the events carry an emit key, unique per cause (crablet_events.emit_key,
-- ADR-0035): the same trigger cannot append the same request twice, whatever its idempotency query says.
--
-- append_events_batch is the insert itself: the events, one row per tag KEY of each in crablet_event_tag_keys (ADR-0019), and a row in crablet_deadlines
-- for each crablet.DeadlineScheduled among them (ADR-0043; that table is in V5, which plpgsql resolves when the function runs).

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

-- What an idempotency condition matched, or NULL when nothing does: the latest matching event in (transaction_id, position) order and the distinct
-- requests behind the matches. One indexed lookup per item, like crablet_items_match_any. The requests are capped: a key that matches more than a few
-- requests is already wrong, and a handful is enough to show it.
CREATE OR REPLACE FUNCTION crablet_items_duplicate(p_items JSONB)
    RETURNS JSONB AS
$$
DECLARE
    v_item     JSONB;
    v_types    TEXT[];
    v_tags     TEXT[];
    v_latest   RECORD;
    v_best     RECORD;
    v_requests JSONB := '[]'::JSONB;
    v_found    BOOLEAN := FALSE;
BEGIN
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RETURN NULL;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
        LOOP
            v_types := ARRAY(SELECT jsonb_array_elements_text(v_item -> 'types'));
            v_tags := ARRAY(SELECT jsonb_array_elements_text(v_item -> 'tags'));
            SELECT e.transaction_id, e.position INTO v_latest
            FROM crablet_events e
            WHERE (cardinality(v_types) = 0 OR e.type = ANY (v_types))
              AND (cardinality(v_tags) = 0 OR e.tags @> v_tags)
            ORDER BY e.transaction_id DESC, e.position DESC
            LIMIT 1;
            IF FOUND THEN
                -- v_best is not assigned before the first match, so it is not compared then (plpgsql does not short-circuit OR).
                IF NOT v_found THEN
                    v_best := v_latest;
                ELSIF (v_latest.transaction_id, v_latest.position) > (v_best.transaction_id, v_best.position) THEN
                    v_best := v_latest;
                END IF;
                v_found := TRUE;
                v_requests := v_requests || COALESCE((
                    SELECT jsonb_agg(DISTINCT jsonb_build_object('fingerprint', encode(r.request_fingerprint, 'hex'), 'causation_id', r.causation_id::TEXT))
                    FROM (SELECT e.request_fingerprint, e.causation_id
                          FROM crablet_events e
                          WHERE (cardinality(v_types) = 0 OR e.type = ANY (v_types))
                            AND (cardinality(v_tags) = 0 OR e.tags @> v_tags)
                          LIMIT 20) r), '[]'::JSONB);
            END IF;
        END LOOP;
    IF NOT v_found THEN
        RETURN NULL;
    END IF;
    RETURN jsonb_build_object(
            'latest_transaction_id', v_best.transaction_id::TEXT,
            'latest_position', v_best.position::TEXT,
            'requests', (SELECT COALESCE(jsonb_agg(DISTINCT r), '[]'::JSONB) FROM jsonb_array_elements(v_requests) r)
           );
END;
$$ LANGUAGE plpgsql STABLE;

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

COMMENT ON FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT, BYTEA) IS
    'Inserts events (and one row per tag KEY of each in crablet_event_tag_keys), with the request fingerprint if given, and returns the position of the last one.';

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor (p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists. Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' (type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. With p_require_fresh_transaction, refuses (CRB01) a transaction that has already written. Stores p_request_fingerprint on the events; a duplicate reports what it matched (crablet_items_duplicate).';
