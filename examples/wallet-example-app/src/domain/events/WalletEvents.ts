import type { Tag } from "@crablet/eventstore/Tag";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as WalletTags from "../WalletTags.ts";

// Port of com.crablet.examples.wallet.events.WalletEvent (sealed) + its 7 implementations. Event
// type name constants double as both the wire `type` string and the Query-building vocabulary
// (WalletQueryPatterns.ts). Each constructor accepts `extraTags` (defaulting to none) so period-
// scoped callers (command handlers, via WalletStatementPeriodResolver) can layer the current
// period's year/month tags on top of the event's own natural tags at append time - WalletEvents.ts
// itself stays agnostic to period-tagging, which is the period resolver's own concern.

export const WALLET_OPENED = "WalletOpened";
export const WALLET_CLOSED = "WalletClosed";
export const DEPOSIT_MADE = "DepositMade";
export const WITHDRAWAL_MADE = "WithdrawalMade";
export const MONEY_TRANSFERRED = "MoneyTransferred";
export const WALLET_STATEMENT_OPENED = "WalletStatementOpened";
export const WALLET_STATEMENT_CLOSED = "WalletStatementClosed";

export interface WalletOpened {
  readonly walletId: string;
  readonly owner: string;
  readonly initialBalance: number;
  readonly openedAt: string;
}
export const walletOpened = (data: WalletOpened): AppendEvent.AppendEvent =>
  AppendEvent.of(WALLET_OPENED, WalletTags.WALLET_ID, data.walletId, data);

// Tombstone - no balance, no period scoping (closing is a lifecycle event, not a transaction).
export interface WalletClosed {
  readonly walletId: string;
  readonly closedAt: string;
}
export const walletClosed = (data: WalletClosed): AppendEvent.AppendEvent =>
  AppendEvent.of(WALLET_CLOSED, WalletTags.WALLET_ID, data.walletId, data);

export interface DepositMade {
  readonly depositId: string;
  readonly walletId: string;
  readonly amount: number;
  readonly newBalance: number;
  readonly depositedAt: string;
  readonly description: string;
}
export const depositMade = (data: DepositMade, extraTags: ReadonlyArray<Tag> = []): AppendEvent.AppendEvent =>
  AppendEvent.builder(DEPOSIT_MADE)
    .tag(WalletTags.WALLET_ID, data.walletId)
    .tag(WalletTags.DEPOSIT_ID, data.depositId)
    .tags(extraTags)
    .data(data)
    .build();

export interface WithdrawalMade {
  readonly withdrawalId: string;
  readonly walletId: string;
  readonly amount: number;
  readonly newBalance: number;
  readonly withdrawnAt: string;
  readonly description: string;
}
export const withdrawalMade = (data: WithdrawalMade, extraTags: ReadonlyArray<Tag> = []): AppendEvent.AppendEvent =>
  AppendEvent.builder(WITHDRAWAL_MADE)
    .tag(WalletTags.WALLET_ID, data.walletId)
    .tag(WalletTags.WITHDRAWAL_ID, data.withdrawalId)
    .tags(extraTags)
    .data(data)
    .build();

export interface MoneyTransferred {
  readonly transferId: string;
  readonly fromWalletId: string;
  readonly toWalletId: string;
  readonly amount: number;
  readonly fromBalance: number;
  readonly toBalance: number;
  readonly transferredAt: string;
  readonly description: string;
}
export const moneyTransferred = (data: MoneyTransferred, extraTags: ReadonlyArray<Tag> = []): AppendEvent.AppendEvent =>
  AppendEvent.builder(MONEY_TRANSFERRED)
    .tag(WalletTags.TRANSFER_ID, data.transferId)
    .tag(WalletTags.FROM_WALLET_ID, data.fromWalletId)
    .tag(WalletTags.TO_WALLET_ID, data.toWalletId)
    .tags(extraTags)
    .data(data)
    .build();

// Period fields are optional beyond year/month - Java's PeriodType supports finer granularity
// (day/hour), but this port only exercises MONTHLY, so `day`/`hour` are always undefined in
// practice; kept as optional fields (not omitted) to match the DB schema's own optional columns.
export interface WalletStatementOpened {
  readonly walletId: string;
  readonly statementId: string;
  readonly year: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly openingBalance: number;
  readonly openedAt: string;
}
export const walletStatementOpened = (data: WalletStatementOpened): AppendEvent.AppendEvent =>
  AppendEvent.builder(WALLET_STATEMENT_OPENED)
    .tag(WalletTags.WALLET_ID, data.walletId)
    .tag(WalletTags.STATEMENT_ID, data.statementId)
    .tag(WalletTags.YEAR, data.year)
    .tag(WalletTags.MONTH, data.month)
    .data(data)
    .build();

export interface WalletStatementClosed {
  readonly walletId: string;
  readonly statementId: string;
  readonly year: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly openingBalance: number;
  readonly closingBalance: number;
  readonly closedAt: string;
}
export const walletStatementClosed = (data: WalletStatementClosed): AppendEvent.AppendEvent =>
  AppendEvent.builder(WALLET_STATEMENT_CLOSED)
    .tag(WalletTags.WALLET_ID, data.walletId)
    .tag(WalletTags.STATEMENT_ID, data.statementId)
    .tag(WalletTags.YEAR, data.year)
    .tag(WalletTags.MONTH, data.month)
    .data(data)
    .build();
