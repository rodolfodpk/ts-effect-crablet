// Tag name constants used across wallet events
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
// month (the default), so period-scoped events carry year/month; with WALLET_PERIOD=minutes:N they carry year/bucket
// instead (day/hour are reserved for other granularities). MoneyTransferred
// carries one shared (year, month) pair too, not separate from/to-prefixed variants - both wallets
// in a transfer always resolve to the same current period (see TransferMoneyCommand.ts).
export const YEAR = "year";
export const MONTH = "month";
export const DAY = "day";
export const HOUR = "hour";
// The N-minute period (WALLET_PERIOD=minutes:N, WalletPeriod.ts): the number of the slot since the epoch.
export const BUCKET = "bucket";

// Any of the tags that name a wallet: what the wallet's views read (a transfer names its wallets as from/to).
export const ANY_WALLET: ReadonlySet<string> = new Set([WALLET_ID, FROM_WALLET_ID, TO_WALLET_ID]);
