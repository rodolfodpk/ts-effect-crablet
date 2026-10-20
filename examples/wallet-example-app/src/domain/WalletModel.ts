import * as Schema from "effect/Schema";
import { defineEvent, defineModel, type PeriodInfo, personal, Tag } from "@crablet/commands/Domain";
import * as WalletTags from "./WalletTags.ts";
import { periodFromEnv, type WalletPeriodFields } from "./WalletPeriod.ts";

// The wallet's events and its decision model, declared once. Each event owns its payload schema and
// which tags it carries; the model derives BOTH the state fold and the consistency-boundary query
// from the handlers below, replacing the hand-written WalletBalanceProjector + WalletQueryPatterns
// pair (which had to be kept in agreement by hand).

export const WalletOpened = defineEvent("WalletOpened", {
  schema: Schema.Struct({
    walletId: Schema.String,
    owner: personal(Schema.String), // a person's name: marked once, so the audit, the log API and the description treat it as personal data
    initialBalance: Schema.Number,
    openedAt: Schema.String
  }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId })
});

// Tombstone: no balance, no period scoping - closing is a lifecycle event, not a transaction.
export const WalletClosed = defineEvent("WalletClosed", {
  schema: Schema.Struct({ walletId: Schema.String, closedAt: Schema.String }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId })
});

// Month, day and hour are optional: monthly statements carry year and month, and the shape keeps the others. `bucket` is the N-minute period (WALLET_PERIOD=minutes:N, WalletPeriod.ts), the lab's way to turn a period while you watch.
const period = {
  year: Schema.Number,
  month: Schema.optional(Schema.Number),
  day: Schema.optional(Schema.Number),
  hour: Schema.optional(Schema.Number),
  bucket: Schema.optional(Schema.Number)
};

export const WalletStatementOpened = defineEvent("WalletStatementOpened", {
  schema: Schema.Struct({
    walletId: Schema.String,
    statementId: Schema.String,
    ...period,
    openingBalance: Schema.Number,
    openedAt: Schema.String
  }),
  tags: (d) => ({
    [WalletTags.WALLET_ID]: d.walletId,
    [WalletTags.STATEMENT_ID]: d.statementId,
    [WalletTags.YEAR]: d.year,
    [WalletTags.MONTH]: d.month,
    [WalletTags.BUCKET]: d.bucket
  })
});

export const WalletStatementClosed = defineEvent("WalletStatementClosed", {
  schema: Schema.Struct({
    walletId: Schema.String,
    statementId: Schema.String,
    ...period,
    openingBalance: Schema.Number,
    closingBalance: Schema.Number,
    closedAt: Schema.String
  }),
  tags: (d) => ({
    [WalletTags.WALLET_ID]: d.walletId,
    [WalletTags.STATEMENT_ID]: d.statementId,
    [WalletTags.YEAR]: d.year,
    [WalletTags.MONTH]: d.month,
    [WalletTags.BUCKET]: d.bucket
  })
});

// `newBalance` is informational (a snapshot for readers of the log); the model folds `amount`.
export const DepositMade = defineEvent("DepositMade", {
  schema: Schema.Struct({
    depositId: Schema.String,
    walletId: Schema.String,
    amount: Schema.Number,
    newBalance: Schema.Number,
    depositedAt: Schema.String,
    description: Schema.String
  }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId, [WalletTags.DEPOSIT_ID]: d.depositId })
});

export const WithdrawalMade = defineEvent("WithdrawalMade", {
  schema: Schema.Struct({
    withdrawalId: Schema.String,
    walletId: Schema.String,
    amount: Schema.Number,
    newBalance: Schema.Number,
    withdrawnAt: Schema.String,
    description: Schema.String
  }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId, [WalletTags.WITHDRAWAL_ID]: d.withdrawalId })
});

export const MoneyTransferred = defineEvent("MoneyTransferred", {
  schema: Schema.Struct({
    transferId: Schema.String,
    fromWalletId: Schema.String,
    toWalletId: Schema.String,
    amount: Schema.Number,
    fromBalance: Schema.Number,
    toBalance: Schema.Number,
    transferredAt: Schema.String,
    description: Schema.String
  }),
  tags: (d) => ({
    [WalletTags.TRANSFER_ID]: d.transferId,
    [WalletTags.FROM_WALLET_ID]: d.fromWalletId,
    [WalletTags.TO_WALLET_ID]: d.toWalletId
  })
});

export interface Wallet {
  readonly exists: boolean;
  readonly balance: number;
  // The balance this period's statement opened with (what its closing reports as `openingBalance`).
  readonly openingBalance: number;
}

// A wallet's state for one statement period (year/month).
//
// - Lifecycle events (open/close) are not period-scoped: they matter whatever period is asked about.
// - The balance carries forward across periods through the statement-opened event's opening balance.
// - Transactions are folded by AMOUNT (deposit adds, withdrawal subtracts, a transfer adds to the
//   receiver and subtracts from the sender), never by the `newBalance` snapshot a writer computed from
//   the state it saw. Snapshots are stale when commutative commands run concurrently (two concurrent
//   deposits both computed from the same balance, so the last snapshot wins and one deposit is lost);
//   a sum of amounts is order-insensitive, which is exactly what a commutative command needs.
// - A transfer is bound to a wallet through either of its two tags, and the side is decided by
//   comparing the wallet ids (both tags are on the event, so "has a from_wallet_id tag" says nothing).
const walletFold = defineModel({
  by: WalletTags.WALLET_ID,
  initial: (): Wallet => ({ exists: false, balance: 0, openingBalance: 0 }),
  scope: (s: { year: number; month: number }) => ({ [WalletTags.YEAR]: s.year, [WalletTags.MONTH]: s.month })
})
  .lifecycle(WalletOpened, (_, d) => ({ exists: true, balance: d.initialBalance, openingBalance: d.initialBalance }))
  .lifecycle(WalletClosed, (w) => ({ ...w, exists: false }))
  .on(WalletStatementOpened, (w, d) => ({ ...w, balance: d.openingBalance, openingBalance: d.openingBalance }))
  .on(DepositMade, (w, d) => ({ ...w, balance: w.balance + d.amount }))
  .on(WithdrawalMade, (w, d) => ({ ...w, balance: w.balance - d.amount }))
  .on(
    MoneyTransferred,
    (w, d, ctx) => ({ ...w, balance: w.balance + (d.toWalletId === ctx.id ? d.amount : -d.amount) }),
    { by: [WalletTags.FROM_WALLET_ID, WalletTags.TO_WALLET_ID] }
  );

// One statement period asked for explicitly (`WalletModel.of({ id, year, month })`): what a read or a test needs.
export const WalletModel = walletFold;

// The statement id of a wallet's period: deterministic, so opening the same period twice is the same statement.
export const statementIdOf = (walletId: string, periodKey: string): string => `wallet:${walletId}:${periodKey}`;

// The CURRENT period, turned by the framework (`.period`, docs/history/plans/period-rollover.md): the first command of a new month closes the previous month's statement and opens the new one
// with the balance carried forward, in the command's own append. Commands use this; they no longer resolve a period themselves.
// #region period-model
export const WalletPeriodModel = walletFold.period(periodFromEnv(), {
  opened: WalletStatementOpened,
  closed: WalletStatementClosed,
  open: (carry, p) => ({
    walletId: p.id,
    statementId: statementIdOf(p.id, p.key),
    ...p.fields,
    openingBalance: carry.balance,
    openedAt: p.at
  }),
  close: (state, p) => ({
    walletId: p.id,
    statementId: statementIdOf(p.id, p.key),
    ...p.fields,
    // Until 2026-10-11 this was `state.balance`, so closings written before then carry their closing balance here too; the statement view
    // takes the opening balance from WalletStatementOpened, so nothing read the wrong value.
    openingBalance: state.openingBalance,
    closingBalance: state.balance,
    closedAt: p.at
  })
});
// #endregion period-model

// The tag that places a period-scoped event (deposit, withdrawal) in its statement, for the statement view. The period's own tags (year, month)
// are added by the framework, to every event the command's model reads (ADR-0041).
export const statementTags = (walletId: string, period: PeriodInfo<WalletPeriodFields>): ReadonlyArray<Tag.Tag> => [
  Tag.of(WalletTags.STATEMENT_ID, statementIdOf(walletId, period.key))
];

// Whether a wallet exists, from its lifecycle events alone - no period, no balance. The boundary of
// commands that only care about the wallet being open or closed (closing it).
export const WalletLifecycleModel = defineModel({
  by: WalletTags.WALLET_ID,
  initial: () => ({ exists: false, closed: false })
})
  .lifecycle(WalletOpened, () => ({ exists: true, closed: false }))
  // `closed` tells a repeated close (already done) from a wallet that never existed.
  .lifecycle(WalletClosed, () => ({ exists: false, closed: true }));

// Whether a wallet id was ever opened, and with what - for opening one. A closed wallet still counts: its id is not reused.
// It keeps the owner and the initial balance so that a retry of the same open is told apart from a different wallet under the same id.
export const WalletOpeningModel = defineModel({
  by: WalletTags.WALLET_ID,
  initial: () => ({ opened: null as { readonly owner: string; readonly initialBalance: number } | null })
}).on(WalletOpened, (_, d) => ({ opened: { owner: d.owner, initialBalance: d.initialBalance } }));
