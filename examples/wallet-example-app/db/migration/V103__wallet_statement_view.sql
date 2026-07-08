-- Materialized view: one row per (wallet, period) statement, maintained by
-- WalletStatementViewProjector. `statement_transactions` is a junction table recording which
-- events have already been folded into a statement's running totals - the projector inserts into
-- it first and only updates totals if that insert actually happened (real idempotency-under-
-- redelivery protection, not just ON CONFLICT DO NOTHING on the statement row itself).
CREATE TABLE wallet_statement_view
(
    statement_id        TEXT           NOT NULL PRIMARY KEY,
    wallet_id            TEXT           NOT NULL,
    year                 INTEGER        NOT NULL,
    month                INTEGER,
    day                  INTEGER,
    hour                 INTEGER,
    opening_balance       DECIMAL(19, 2) NOT NULL,
    closing_balance       DECIMAL(19, 2),
    total_deposits        DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_withdrawals     DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_transfers_in    DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_transfers_out   DECIMAL(19, 2) NOT NULL DEFAULT 0,
    transaction_count    INTEGER        NOT NULL DEFAULT 0,
    opened_at             TIMESTAMP WITH TIME ZONE NOT NULL,
    closed_at             TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_wallet_statement_view_hour_requires_day CHECK (hour IS NULL OR day IS NOT NULL),
    CONSTRAINT chk_wallet_statement_view_day_requires_month CHECK (day IS NULL OR month IS NOT NULL),
    CONSTRAINT chk_wallet_statement_view_closing_requires_closed_at
        CHECK ((closing_balance IS NULL) = (closed_at IS NULL))
);

CREATE INDEX idx_wallet_statement_view_wallet_period ON wallet_statement_view (wallet_id, year, month);
CREATE INDEX idx_wallet_statement_view_open_period ON wallet_statement_view (wallet_id) WHERE closed_at IS NULL;

CREATE TABLE statement_transactions
(
    statement_id   TEXT   NOT NULL REFERENCES wallet_statement_view (statement_id) ON DELETE CASCADE,
    event_position BIGINT NOT NULL,
    PRIMARY KEY (statement_id, event_position)
);
