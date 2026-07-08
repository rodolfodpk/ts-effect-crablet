-- Materialized view: one row per transaction event, maintained by WalletTransactionViewProjector.
-- A transfer produces two rows ({transferId}-from, {transferId}-to) - one per affected wallet.
--
-- Deliberately no FK to wallet_balance_view: confirmed by a real failing test during this port
-- (this view's own projector inserting a transaction row before wallet_balance_view's projector
-- has processed WalletOpened for the same wallet - both are independent async projections off the
-- same event stream, with no cross-view ordering guarantee). Java's own V103 migration already
-- fixed this exact race for wallet_summary_view but left wallet_transaction_view's FK in place -
-- this port fixes it here too for consistency, rather than reproducing a latent race.
CREATE TABLE wallet_transaction_view
(
    transaction_id TEXT           NOT NULL,
    wallet_id      TEXT           NOT NULL,
    event_type     TEXT           NOT NULL,
    amount         DECIMAL(19, 2) NOT NULL,
    description    TEXT           NOT NULL,
    occurred_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    event_position BIGINT         NOT NULL,
    PRIMARY KEY (transaction_id, event_position)
);

CREATE INDEX idx_wallet_transaction_view_wallet_occurred ON wallet_transaction_view (wallet_id, occurred_at DESC);
CREATE INDEX idx_wallet_transaction_view_position ON wallet_transaction_view (event_position);
