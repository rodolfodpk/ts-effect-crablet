-- Materialized view: running totals per wallet, maintained by WalletSummaryViewProjector.
-- Deliberately no FK to wallet_balance_view - both are independent async projections off the same
-- event stream, so summary's own projector can process WalletOpened before balance's does; an FK
-- here would risk a spurious constraint violation on a legitimate, just-differently-ordered write.
CREATE TABLE wallet_summary_view
(
    wallet_id             TEXT           NOT NULL PRIMARY KEY,
    total_deposits        DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_withdrawals     DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_transfers_in    DECIMAL(19, 2) NOT NULL DEFAULT 0,
    total_transfers_out   DECIMAL(19, 2) NOT NULL DEFAULT 0,
    current_balance       DECIMAL(19, 2) NOT NULL DEFAULT 0,
    last_transaction_at   TIMESTAMP WITH TIME ZONE
);
