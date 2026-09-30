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

export type WalletOpened = ReturnType<typeof M.WalletOpened.decode>;
export type WalletClosed = ReturnType<typeof M.WalletClosed.decode>;
export type DepositMade = ReturnType<typeof M.DepositMade.decode>;
export type WithdrawalMade = ReturnType<typeof M.WithdrawalMade.decode>;
export type MoneyTransferred = ReturnType<typeof M.MoneyTransferred.decode>;
export type WalletStatementOpened = ReturnType<typeof M.WalletStatementOpened.decode>;
export type WalletStatementClosed = ReturnType<typeof M.WalletStatementClosed.decode>;
