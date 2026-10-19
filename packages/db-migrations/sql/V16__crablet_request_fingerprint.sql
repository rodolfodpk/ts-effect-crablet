-- A repeat must be the same request (ADR-0034).
--
-- An idempotency query (`idempotentBy`) finds the events that show an operation was already done. Until now a match only said "done", so a client that
-- reused a request id with a different body (the same deposit id, another amount) got "already done" for a request that was never applied. Each append of
-- a command with an idempotency key now stores a fingerprint of the request (a SHA-256 of the command's name and its encoded input) on its events, and a
-- duplicate reports what it matched: the latest matching event (so a repeat can answer with a read-your-writes marker) and the distinct
-- (fingerprint, causation) pairs behind the matches (so the executor can tell the same request from a different one). Events appended before this
-- migration have no fingerprint: a match on them is "already done", as before.

ALTER TABLE crablet_events ADD COLUMN request_fingerprint BYTEA;

COMMENT ON COLUMN crablet_events.request_fingerprint IS
    'SHA-256 of the command name and its encoded input, for the events of a command with an idempotency key; NULL otherwise. Compared when the key repeats.';

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

DROP FUNCTION IF EXISTS append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT);

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
                                    correlation_id, causation_id, request_fingerprint)
            SELECT t.type,
                   t.tag_string::TEXT[],
                   t.data,
                   pg_current_xact_id(),
                   p_occurred_at,
                   p_correlation_id,
                   p_causation_id,
                   p_request_fingerprint
            FROM UNNEST($1, $2, $3) AS t(type, tag_string, data)
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

COMMENT ON FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT, BYTEA) IS
    'Inserts events (and one row per tag KEY of each in crablet_event_tag_keys), with the request fingerprint if given, and returns the position of the last one.';

DROP FUNCTION IF EXISTS append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN);

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

    v_last_position := append_events_batch(
            p_types,
            p_tags,
            p_data,
            COALESCE(p_occurred_at, CURRENT_TIMESTAMP),
            p_correlation_id,
            p_causation_id,
            p_request_fingerprint
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

COMMENT ON FUNCTION append_events_if(TEXT[], TEXT[], JSONB[], JSONB, BIGINT, JSONB, TIMESTAMP WITH TIME ZONE, UUID, BIGINT, TEXT, TEXT, XID8, BOOLEAN, BYTEA) IS
    'Atomically appends events if no duplicate (p_idempotency_items) and no conflicting event after the cursor '
    '(p_after_cursor_transaction_id, p_after_cursor_position) in (transaction_id, position) order (p_concurrency_items) exists. '
    'Conditions are JSONB arrays of {types, tags} items, OR-ed together. Writers lock their own events'' and their conditions'' '
    '(type, tag) pairs with pg_advisory_xact_lock; requires READ COMMITTED. With p_require_fresh_transaction, refuses (CRB01) a transaction '
    'that has already written. Stores p_request_fingerprint on the events; a duplicate reports what it matched (crablet_items_duplicate).';
