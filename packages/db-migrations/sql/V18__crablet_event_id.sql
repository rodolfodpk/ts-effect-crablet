-- Every event gets a stable public id (ADR-0036).
--
-- An event's `position` identifies it inside this store, and the pair (transaction_id, position) orders it; neither survives the log being copied to
-- another store. `event_id` does: it is what a sink is given as the message id (an outbox publisher, a broker that deduplicates by id, a CloudEvents
-- `id`), so a republished event is recognised as the same message wherever it goes. uuidv7 (Postgres 18) keeps inserts cheap, but it sorts by when it was
-- generated, not by log order: never order or take a high-water mark by it. No index: nothing looks an event up by id yet, and one can be added with
-- CREATE INDEX CONCURRENTLY when something does.
--
-- Adding a NOT NULL column with a volatile default rewrites the table (and gives every existing event an id) under an exclusive lock: fine for a young
-- log. For a large one: add the column nullable with the default, backfill in batches (UPDATE ... SET event_id = uuidv7() WHERE event_id IS NULL AND
-- position BETWEEN ...), then ADD a CHECK (event_id IS NOT NULL) NOT VALID, VALIDATE it, and SET NOT NULL.

ALTER TABLE crablet_events ADD COLUMN event_id UUID NOT NULL DEFAULT uuidv7();

COMMENT ON COLUMN crablet_events.event_id IS
    'The event''s stable public id (uuidv7): the message id a sink is given. Not an order: order is (transaction_id, position).';
