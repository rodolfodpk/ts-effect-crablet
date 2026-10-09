import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { EventStoreService } from "@crablet/eventstore";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import type { AppendTooLarge, Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { defineModel } from "@crablet/commands/Model";
import * as WalletTags from "../WalletTags.ts";
import {
  DepositMade,
  MoneyTransferred,
  WalletModel,
  WalletStatementClosed,
  WalletStatementOpened,
  WithdrawalMade
} from "../WalletModel.ts";

// The "closing the books" step every wallet command runs before deciding: is there already an open
// statement for this wallet's CURRENT calendar month? If not, lazily append one - closing the previous
// month's statement first, but only if that statement actually had any transactions.
//
// It runs as a command's `prepare` step, so all of it happens inside the command's transaction: if the
// command is retried or fails, the statement events it appended are rolled back with it.
//
// The key insight that makes it tractable: the period-scoped model a command already needs
// (WalletModel) is also exactly what computes a period's running balance - bootstrapped by
// `WalletOpened.initialBalance` for a wallet's very first period, or by that period's own
// `WalletStatementOpened.openingBalance`, carried forward from the previous period's close - so no
// separate "full history" balance query is needed.

export interface ActivePeriod {
  readonly year: number;
  readonly month: number;
  readonly statementId: string;
}

// The tags that place a period-scoped event (deposit, withdrawal, transfer) in its period and statement.
export const periodTags = (period: ActivePeriod): ReadonlyArray<Tag.Tag> => [
  Tag.of(WalletTags.YEAR, String(period.year)),
  Tag.of(WalletTags.MONTH, String(period.month)),
  Tag.of(WalletTags.STATEMENT_ID, period.statementId)
];

// Which statement (if any) is open for a wallet: the last statement event decides.
const initialTracking = { openStatementId: null as string | null, openYear: null as number | null, openMonth: null as number | null };
// (exported for the model-impact test)
export const StatementTracking = defineModel({ by: WalletTags.WALLET_ID, initial: () => initialTracking })
  .on(WalletStatementOpened, (_, d) => ({ openStatementId: d.statementId, openYear: d.year, openMonth: d.month ?? null }))
  .on(WalletStatementClosed, () => initialTracking);

const pad2 = (n: number): string => String(n).padStart(2, "0");
const toStatementId = (walletId: string, year: number, month: number): string =>
  `wallet:${walletId}:${year}-${pad2(month)}`;

// Did the (old) period have any transaction at all? Deposits and withdrawals are bound by wallet_id,
// a transfer by either of its two wallet tags.
const periodTransactionsQuery = (walletId: string, year: number, month: number): Query.Query => {
  const period = [Tag.of(WalletTags.YEAR, String(year)), Tag.of(WalletTags.MONTH, String(month))];
  return Query.of([
    Query.queryItemOf([DepositMade.type, WithdrawalMade.type], [Tag.of(WalletTags.WALLET_ID, walletId), ...period]),
    Query.queryItemOf([MoneyTransferred.type], [Tag.of(WalletTags.FROM_WALLET_ID, walletId), ...period]),
    Query.queryItemOf([MoneyTransferred.type], [Tag.of(WalletTags.TO_WALLET_ID, walletId), ...period])
  ]);
};

export const resolveActivePeriod = (
  eventStore: EventStoreService,
  walletId: string,
  now: Date = new Date()
): Effect.Effect<ActivePeriod, AppendTooLarge | SqlError | Conflict | Duplicate | EventDecodingError, never> =>
  Effect.gen(function* () {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    const tracking = yield* StatementTracking.of({ id: walletId }).load(eventStore);
    const open = tracking.state;

    // The current period already has an open statement: nothing to do.
    if (open.openYear === year && open.openMonth === month && open.openStatementId !== null) {
      return { year, month, statementId: open.openStatementId };
    }

    // Otherwise lazily close the previous period's statement (if any, and only if it had transactions)
    // and open this one, carrying the balance forward.
    let carryForwardBalance: number;
    if (open.openStatementId !== null && open.openYear !== null && open.openMonth !== null) {
      const oldPeriod = yield* WalletModel.of({ id: walletId, year: open.openYear, month: open.openMonth }).load(eventStore);
      carryForwardBalance = oldPeriod.state.balance;

      if (yield* eventStore.exists(periodTransactionsQuery(walletId, open.openYear, open.openMonth))) {
        yield* eventStore.append(
          [
            WalletStatementClosed({
              walletId,
              statementId: open.openStatementId,
              year: open.openYear,
              month: open.openMonth,
              openingBalance: carryForwardBalance,
              closingBalance: carryForwardBalance,
              closedAt: now.toISOString()
            })
          ],
          // refuse if another statement event landed since we read the old period
          AppendCondition.of(oldPeriod.logPosition, StatementTracking.of({ id: walletId }).query)
        );
      }
    } else {
      // This wallet's very first statement ever - the opening balance is WalletOpened's initial balance.
      carryForwardBalance = (yield* WalletModel.of({ id: walletId, year, month }).load(eventStore)).state.balance;
    }

    const statementId = toStatementId(walletId, year, month);
    yield* eventStore.append([
      WalletStatementOpened({ walletId, statementId, year, month, openingBalance: carryForwardBalance, openedAt: now.toISOString() })
    ]);
    return { year, month, statementId };
  });
