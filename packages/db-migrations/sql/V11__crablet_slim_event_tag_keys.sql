-- A slim tag-key table (ADR-0019).
--
-- crablet_event_tags had a row per tag with (key, value, position), a primary key on all three, and two more indexes, plus a foreign key to crablet_events. Only one
-- question was ever asked of it: "which events carry a tag with this KEY?" (the pollers' requiredTags / anyOfTags selections). Nothing reads `value` (a tag's value is
-- looked up through crablet_events.tags and its GIN index), the primary key (key, position) answers that question by itself, and the table is derived data, so it
-- needs no foreign key. Measured on 1,000,000 wallet-shaped events with the pollers' real queries: the same reads (a rare-key catch-up 0.6 ms against 0.8 ms),
-- 44 % of the space (420 MiB against 958 MiB), and 2.3 times the append throughput.
--
-- crablet_event_tag_keys holds ONE row per (key, position), even when an event carries the same key more than once (a list-valued tag such as product_id=p1,
-- product_id=p2): the insert is DISTINCT, otherwise the primary key would refuse the second one.
--
-- Consequence of having no foreign key: TRUNCATE crablet_events ... CASCADE no longer clears the key table, and deleting events leaves their key rows behind
-- (harmless to the pollers, which join through crablet_events). Anything that resets a log (a test, a development database) must truncate both tables, because
-- positions then restart at 1 and would collide with the stale rows.
--
-- The new table is filled from crablet_events.tags, the source of truth, not from the old table. Writers are paused for the length of this migration
-- (SHARE ROW EXCLUSIVE conflicts with the row locks of INSERT; readers carry on), so no event can be appended by the old function between the backfill and the
-- function swap and be missing from the new table. The pause is as long as the backfill: a full scan of crablet_events, so plan a window on a large log.

LOCK TABLE crablet_events IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE crablet_event_tag_keys
(
    key      TEXT   NOT NULL,
    position BIGINT NOT NULL,
    PRIMARY KEY (key, position)
);

INSERT INTO crablet_event_tag_keys (key, position)
SELECT DISTINCT split_part(tag, '=', 1), e.position
FROM crablet_events e,
     LATERAL unnest(e.tags) AS tag
WHERE tag LIKE '%=%';

CREATE OR REPLACE FUNCTION append_events_batch(
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
             INSERT INTO crablet_event_tag_keys (key, position)
                 SELECT DISTINCT split_part(tag, '=', 1), i.position
                 FROM inserted i,
                      LATERAL unnest(i.tags) AS tag
                 WHERE tag LIKE '%=%')
    SELECT max(position) INTO v_last_position FROM inserted;
    RETURN v_last_position;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_events_batch(TEXT[], TEXT[], JSONB[], TIMESTAMP WITH TIME ZONE, UUID, BIGINT) IS
    'Inserts events (and one row per tag KEY of each in crablet_event_tag_keys) and returns the position of the last one.';

DROP TABLE crablet_event_tags;

COMMENT ON TABLE crablet_event_tag_keys IS
    'Derived: one row per (tag key, event position), maintained atomically from crablet_events.tags on append, so the pollers can ask which events carry a tag with a given key. crablet_events.tags is the source of truth; this table can be rebuilt from it.';
