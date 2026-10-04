-- The transaction list pages by keyset on (occurred_at, event_position, transaction_id), newest first, within one wallet
-- (see src/api/TransactionPaging.ts). This index is that order, so a page is an index range scan however deep it is.
-- It replaces V101's (wallet_id, occurred_at DESC), whose columns are this index's leading ones.
CREATE INDEX idx_wallet_transaction_view_wallet_page
    ON wallet_transaction_view (wallet_id, occurred_at DESC, event_position DESC, transaction_id DESC);

DROP INDEX idx_wallet_transaction_view_wallet_occurred;
