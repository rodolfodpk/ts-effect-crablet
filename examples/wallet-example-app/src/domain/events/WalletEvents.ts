import * as M from "../WalletModel.ts";

// Event type names and payload types for the READ side (views, automations, tests that build raw
// events), derived from the event definitions in WalletModel.ts - the single source of truth - so
// they cannot drift from what the commands write.

export const WALLET_OPENED = M.WalletOpened.type;
export const WALLET_CLOSED = M.WalletClosed.type;
export const DEPOSIT_MADE = M.DepositMade.type;
export const WITHDRAWAL_MADE = M.WithdrawalMade.type;
export const MONEY_TRANSFERRED = M.MoneyTransferred.type;
export const WALLET_STATEMENT_OPENED = M.WalletStatementOpened.type;
export const WALLET_STATEMENT_CLOSED = M.WalletStatementClosed.type;

export type WalletOpened = typeof M.WalletOpened.Type;
export type WalletClosed = typeof M.WalletClosed.Type;
export type DepositMade = typeof M.DepositMade.Type;
export type WithdrawalMade = typeof M.WithdrawalMade.Type;
export type MoneyTransferred = typeof M.MoneyTransferred.Type;
export type WalletStatementOpened = typeof M.WalletStatementOpened.Type;
export type WalletStatementClosed = typeof M.WalletStatementClosed.Type;
