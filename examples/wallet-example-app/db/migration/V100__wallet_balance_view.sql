-- Materialized view: current balance per wallet, maintained by WalletBalanceViewProjector.
CREATE TABLE wallet_balance_view
(
    wallet_id       TEXT           NOT NULL PRIMARY KEY,
    owner           TEXT           NOT NULL,
    balance         DECIMAL(19, 2) NOT NULL,
    last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_wallet_balance_view_owner ON wallet_balance_view (owner);
