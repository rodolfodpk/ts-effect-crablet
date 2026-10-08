-- Model snapshots are removed (ADR-0018, superseded).
--
-- V9 added crablet_model_snapshots and crablet_save_snapshot(), V10 added the entity column and the seven-argument function. The feature was opt-in, no application
-- used it, and the cheaper remedy for a long history (scoping a model by period) covers the realistic cases, so it was dropped (2026-10-07). The last commit that
-- contains the code is recorded in docs/adr/0018-model-snapshots.md.
--
-- V9 and V10 stay in the history, so a database that applied them gets here the same way a fresh one does. Nothing else refers to this table or function.

DROP FUNCTION IF EXISTS crablet_save_snapshot(TEXT, INTEGER, TEXT, XID8, BIGINT, JSONB, JSONB);
DROP TABLE IF EXISTS crablet_model_snapshots;
