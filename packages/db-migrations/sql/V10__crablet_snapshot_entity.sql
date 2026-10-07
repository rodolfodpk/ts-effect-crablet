-- Snapshots remember WHICH entity they are for (ADR-0018, verify-snapshots).
--
-- V9 keys a snapshot by a hash of the model's boundary query, which is right for reading but cannot be reversed: a verifier that wants to re-fold an entity's full
-- boundary and compare it with the snapshot needs the model's `of(...)` arguments (the id, and any scope such as a year). `entity` holds them as JSON, e.g.
-- {"id": "w-17", "year": 2026}. NULL for rows written before this migration (they are reported as unverifiable, and replaced by the next write).
-- Not part of the key: two writers of the same key always write the same entity.

ALTER TABLE crablet_model_snapshots
    ADD COLUMN entity JSONB;

DROP FUNCTION IF EXISTS crablet_save_snapshot(TEXT, INTEGER, TEXT, XID8, BIGINT, JSONB);

-- Same forward-only rule as V9; `p_entity` is stored with the row.
CREATE OR REPLACE FUNCTION crablet_save_snapshot(
    p_name           TEXT,
    p_version        INTEGER,
    p_fingerprint    TEXT,
    p_transaction_id XID8,
    p_position       BIGINT,
    p_state          JSONB,
    p_entity         JSONB DEFAULT NULL
) RETURNS BOOLEAN AS
$$
DECLARE
    v_written INTEGER;
BEGIN
    INSERT INTO crablet_model_snapshots AS s (name, version, fingerprint, transaction_id, position, state, entity)
    VALUES (p_name, p_version, p_fingerprint, p_transaction_id, p_position, p_state, p_entity)
    ON CONFLICT (name, version, fingerprint) DO UPDATE
        SET transaction_id = EXCLUDED.transaction_id,
            position       = EXCLUDED.position,
            state          = EXCLUDED.state,
            entity         = EXCLUDED.entity,
            updated_at     = CURRENT_TIMESTAMP
    WHERE (s.transaction_id, s.position) < (EXCLUDED.transaction_id, EXCLUDED.position);
    GET DIAGNOSTICS v_written = ROW_COUNT;
    RETURN v_written > 0;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN crablet_model_snapshots.entity IS
    'The model''s of(...) arguments as JSON (id and scope), so a verifier can rebuild the model instance. NULL for rows written before V10.';
COMMENT ON FUNCTION crablet_save_snapshot(TEXT, INTEGER, TEXT, XID8, BIGINT, JSONB, JSONB) IS
    'Insert a snapshot, or replace the existing one only if the new cursor is later in (transaction_id, position) order. Returns whether a row was written.';
