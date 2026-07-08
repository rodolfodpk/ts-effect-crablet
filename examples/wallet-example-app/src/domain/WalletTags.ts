// Port of com.crablet.examples.wallet.WalletTags - tag name constants used across wallet events
// and decision-model queries.
export const WALLET_ID = "wallet_id";
export const DEPOSIT_ID = "deposit_id";
export const WITHDRAWAL_ID = "withdrawal_id";
export const TRANSFER_ID = "transfer_id";
export const FROM_WALLET_ID = "from_wallet_id";
export const TO_WALLET_ID = "to_wallet_id";
export const STATEMENT_ID = "statement_id";
// A transfer touches two wallets, each with its own (wallet-scoped) statement id string - tagged
// directly on MoneyTransferred at append time so WalletStatementViewProjector.ts never needs to
// recompute the "wallet:{id}:{year}-{month}" format string itself, only read it off the event.
export const FROM_STATEMENT_ID = "from_statement_id";
export const TO_STATEMENT_ID = "to_statement_id";

// Period ("closing the books") tags - every wallet command is scoped to the current calendar
// month, so period-scoped events carry year/month (day/hour reserved for finer-grained
// PeriodType values Java supports but this port doesn't use - only MONTHLY). MoneyTransferred
// carries one shared (year, month) pair too, not separate from/to-prefixed variants - both wallets
// in a transfer always resolve to the same current period (see TransferMoneyCommand.ts).
export const YEAR = "year";
export const MONTH = "month";
export const DAY = "day";
export const HOUR = "hour";
