import { defineView, type ViewContext } from "@crablet/views/ProjectedView";
import { decimal, integer, text, timestamptz, viewTable } from "@crablet/views/ViewTable";
import * as WalletTags from "../domain/WalletTags.ts";
import * as Wallet from "../domain/WalletModel.ts";

export const walletStatementTable = viewTable("wallet_statement_view", {
  key: { statement_id: text() },
  columns: {
    wallet_id: text(),
    year: integer(),
    month: integer().nullable(),
    day: integer().nullable(),
    hour: integer().nullable(),
    opening_balance: decimal(),
    closing_balance: decimal().nullable(),
    total_deposits: decimal().default(0),
    total_withdrawals: decimal().default(0),
    total_transfers_in: decimal().default(0),
    total_transfers_out: decimal().default(0),
    transaction_count: integer().default(0),
    opened_at: timestamptz(),
    closed_at: timestamptz().nullable()
  }
});

// One row per (wallet, period) statement. The statement a transaction belongs to is the `statement_id` TAG on the event (a transfer has two, one per wallet: from_statement_id and to_statement_id, see
// WalletTags.ts's primer), so each event adds its amount to the totals of the statement it names; an event with no such tag is skipped.
//
// Opened is `ignore` (opening the same statement twice is the same statement); Closed sets the closing balance and instant. The totals are `add`s: a repeated batch is applied once because the
// view's batch and its cursor commit together (ADR-0023). (This view used to keep a junction table of the events it had folded in, `statement_transactions`; V105 drops it.)
const bump = (ctx: ViewContext, tag: string, column: "total_deposits" | "total_withdrawals" | "total_transfers_in" | "total_transfers_out", amount: number) => {
  const statementId = ctx.tag(tag);
  return statementId === undefined
    ? undefined
    : walletStatementTable.update({ statement_id: statementId }, { add: { [column]: amount, transaction_count: 1 } });
};

export const WalletStatementView = defineView("wallet-statement-view", { tables: [walletStatementTable], anyOfTags: WalletTags.ANY_WALLET })
  .on(Wallet.WalletStatementOpened, (d) =>
    walletStatementTable.insert(
      {
        statement_id: d.statementId,
        wallet_id: d.walletId,
        year: d.year,
        month: d.month ?? null,
        day: d.day ?? null,
        hour: d.hour ?? null,
        opening_balance: d.openingBalance,
        opened_at: d.openedAt
      },
      { onConflict: "ignore" }
    )
  )
  .on(Wallet.WalletStatementClosed, (d) =>
    walletStatementTable.update({ statement_id: d.statementId }, { set: { closing_balance: d.closingBalance, closed_at: d.closedAt } })
  )
  .on(Wallet.DepositMade, (d, ctx) => bump(ctx, WalletTags.STATEMENT_ID, "total_deposits", d.amount))
  .on(Wallet.WithdrawalMade, (d, ctx) => bump(ctx, WalletTags.STATEMENT_ID, "total_withdrawals", d.amount))
  .on(Wallet.MoneyTransferred, (d, ctx) => [
    bump(ctx, WalletTags.FROM_STATEMENT_ID, "total_transfers_out", d.amount),
    bump(ctx, WalletTags.TO_STATEMENT_ID, "total_transfers_in", d.amount)
  ]);

