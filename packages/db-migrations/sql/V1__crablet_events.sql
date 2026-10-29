-- The event log (ADR-0047: one file per part of the schema, in its final shape).
--
-- crablet_events is the log: one row per event, found by its tags. `tags` is the source of truth for an event's tags, queried through its GIN index by
-- the append condition and the idempotency check.
--
-- Order is (transaction_id, position), not position alone (ADR-0012): transaction_id is PostgreSQL's xid8 for the transaction that appended the row, shared
-- by every event of that append and linking them to the command audit row (crablet_commands). It is not a business transaction id such as a transfer id.
-- A sequence value and a transaction id can be taken in opposite orders, so a reader that follows the log takes the pair
-- (see https://event-driven.io/en/ordering_in_postgres_outbox/).
--
-- request_fingerprint (ADR-0034): a SHA-256 of the command's name and its encoded input, stored on the events of a command with an idempotency key, so a
-- repeat of the key with a different request is told apart from the same request again.
--
-- emit_key (ADR-0035): for an event appended under a cause (an automation's trigger), the request's fingerprint and the event's place in its append, unique
-- per cause. A redelivered trigger that appends the same request again hits the index and is a duplicate, whatever the command's own idempotency query said.
-- The key is the request's content, not the decision's index, so a redelivery whose decide returns more or other decisions still appends what is new.
--
-- event_id (ADR-0036): a stable public id, what a sink is given as the message id, so a republished event is recognised as the same message wherever it goes.
-- uuidv7 (Postgres 18) keeps inserts cheap, but it sorts by when it was generated, not by log order: never order or take a high-water mark by it. No index:
-- nothing looks an event up by id yet.

CREATE TABLE crablet_events
(
    type                TEXT                     NOT NULL,
    tags                TEXT[]                   NOT NULL,
    data                JSONB                    NOT NULL,
    transaction_id      xid8                     NOT NULL,
    position            BIGSERIAL                NOT NULL PRIMARY KEY,
    occurred_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id      UUID,
    causation_id        BIGINT,
    request_fingerprint BYTEA,
    emit_key            TEXT,
    event_id            UUID                     NOT NULL DEFAULT uuidv7(),
    CONSTRAINT chk_event_type_length CHECK (LENGTH(type) BETWEEN 1 AND 64)
);

CREATE INDEX idx_crablet_events_transaction_position_btree ON crablet_events (transaction_id, position);
CREATE INDEX idx_crablet_events_type_position ON crablet_events (type, position);
CREATE INDEX idx_crablet_events_tags_gin ON crablet_events USING GIN (tags);
CREATE INDEX idx_crablet_events_correlation_id ON crablet_events (correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_crablet_events_emit_key ON crablet_events (causation_id, emit_key) WHERE emit_key IS NOT NULL;

COMMENT ON TABLE crablet_events IS
    'Canonical Crablet event log. tags is the source of truth for event tags.';

COMMENT ON COLUMN crablet_events.correlation_id IS
    'Business operation thread ID shared by all events caused by one user request, including automation-triggered downstream events.';

COMMENT ON COLUMN crablet_events.causation_id IS
    'Position (crablet_events.position) of the event that directly triggered this event. NULL for direct user actions.';

COMMENT ON COLUMN crablet_events.transaction_id IS
    'PostgreSQL xid8 for the transaction that appended this event; shared by all events appended in the same transaction and used to join command audit rows. Not a business transaction ID.';

COMMENT ON COLUMN crablet_events.request_fingerprint IS
    'SHA-256 of the command name and its encoded input, for the events of a command with an idempotency key; NULL otherwise. Compared when the key repeats.';

COMMENT ON COLUMN crablet_events.emit_key IS
    'For an event appended under a cause (an automation trigger): the request fingerprint and the event''s place in its append. Unique per cause.';

COMMENT ON COLUMN crablet_events.event_id IS
    'The event''s stable public id (uuidv7): the message id a sink is given. Not an order: order is (transaction_id, position).';

-- crablet_event_tag_keys (ADR-0019): one row per (tag key, event position), so the pollers can ask "which events carry a tag with this KEY?" (their
-- requiredTags / anyOfTags selections) without scanning the log. That is the only question asked of it: a tag's value is looked up through
-- crablet_events.tags. ONE row per (key, position), even when an event carries the same key more than once (a list-valued tag such as product_id=p1,
-- product_id=p2): the append's insert is DISTINCT, otherwise the primary key would refuse the second one.
--
-- It is derived data, written by the append in the same statement, so it has no foreign key. Consequence: TRUNCATE crablet_events ... CASCADE does not
-- clear it, and deleting events leaves their key rows behind (harmless to the pollers, which join through crablet_events). Anything that resets a log (a
-- test, a development database) must truncate both tables, because positions then restart at 1 and would collide with the stale rows.

CREATE TABLE crablet_event_tag_keys
(
    key      TEXT   NOT NULL,
    position BIGINT NOT NULL,
    PRIMARY KEY (key, position)
);

COMMENT ON TABLE crablet_event_tag_keys IS
    'Derived: one row per (tag key, event position), maintained atomically from crablet_events.tags on append, so the pollers can ask which events carry a tag with a given key. crablet_events.tags is the source of truth; this table can be rebuilt from it.';
