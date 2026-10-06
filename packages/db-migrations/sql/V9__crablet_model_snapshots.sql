-- Model snapshots (ADR-0018): a cache of a model's folded state at a settled cursor, so a command reads the events after the snapshot instead of the whole boundary.
--
-- A snapshot is DERIVED data, never a fact: it can be deleted at any time without losing anything (a load that finds none, or one it cannot use, folds the full
-- boundary). It is keyed by what the state is a state OF:
--   name         the model's declared snapshot name
--   version      the number its author bumps when the fold changes (a changed fold cannot be detected from the data)
--   fingerprint  a hash of the model's boundary query, which contains the entity's tags: a different set of handled events or a different entity is a different key
-- and holds the cursor it was folded to, as the (transaction_id, position) pair every cursor in this schema is (ADR-0012): the load's SETTLED cursor, so no event can
-- later appear below it.
--
-- Rows are never updated except forward: crablet_save_snapshot() keeps the row with the later cursor, so a slow writer never moves a snapshot back.

CREATE TABLE crablet_model_snapshots
(
    name           TEXT                     NOT NULL,
    version        INTEGER                  NOT NULL,
    fingerprint    TEXT                     NOT NULL,
    transaction_id XID8                     NOT NULL,
    position       BIGINT                   NOT NULL,
    state          JSONB                    NOT NULL,
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name, version, fingerprint),
    CONSTRAINT chk_crablet_snapshot_name_length CHECK (LENGTH(name) BETWEEN 1 AND 64),
    CONSTRAINT chk_crablet_snapshot_version CHECK (version >= 0),
    CONSTRAINT chk_crablet_snapshot_position CHECK (position >= 0)
);

-- Insert, or replace only when the new cursor is LATER in (transaction_id, position) order. True when the row was written.
CREATE OR REPLACE FUNCTION crablet_save_snapshot(
    p_name           TEXT,
    p_version        INTEGER,
    p_fingerprint    TEXT,
    p_transaction_id XID8,
    p_position       BIGINT,
    p_state          JSONB
) RETURNS BOOLEAN AS
$$
DECLARE
    v_written INTEGER;
BEGIN
    INSERT INTO crablet_model_snapshots AS s (name, version, fingerprint, transaction_id, position, state)
    VALUES (p_name, p_version, p_fingerprint, p_transaction_id, p_position, p_state)
    ON CONFLICT (name, version, fingerprint) DO UPDATE
        SET transaction_id = EXCLUDED.transaction_id,
            position       = EXCLUDED.position,
            state          = EXCLUDED.state,
            updated_at     = CURRENT_TIMESTAMP
    WHERE (s.transaction_id, s.position) < (EXCLUDED.transaction_id, EXCLUDED.position);
    GET DIAGNOSTICS v_written = ROW_COUNT;
    RETURN v_written > 0;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE crablet_model_snapshots IS
    'Cache of a model''s folded state at a settled (transaction_id, position) cursor (ADR-0018). Derived data: safe to delete at any time. Keyed by (name, version, fingerprint of the boundary query).';
COMMENT ON FUNCTION crablet_save_snapshot(TEXT, INTEGER, TEXT, XID8, BIGINT, JSONB) IS
    'Insert a snapshot, or replace the existing one only if the new cursor is later in (transaction_id, position) order. Returns whether a row was written.';
