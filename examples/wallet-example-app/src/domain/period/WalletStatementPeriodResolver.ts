import { Effect } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type { EventStoreService, StateProjector } from "@crablet/eventstore";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import * as StreamPositionNS from "@crablet/eventstore/StreamPosition";
import type { StreamPosition } from "@crablet/eventstore/StreamPosition";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import * as WalletTags from "../WalletTags.ts";
import * as WalletEvents from "../events/WalletEvents.ts";
import * as WalletQueryPatterns from "../WalletQueryPatterns.ts";
import { walletBalanceProjector, initialWalletBalanceState } from "../WalletBalanceProjector.ts";

// Port of com.crablet.examples.wallet.period.WalletStatementPeriodResolver - the "closing the
// books" logic every wallet command runs before deciding: is there already an open
// WalletStatementOpened for this wallet's *current* calendar month? If not, lazily append one
// (closing the previous month's statement first, via WalletStatementClosed, but only if that
// statement actually had any transactions).
//
// This is the single most novel/highest-risk piece of domain logic in the whole app (flagged as
// such in the port's own plan) - the key insight that makes it tractable: the SAME period-scoped
// decision-model query command handlers already need (WalletQueryPatterns.
// singleWalletActivePeriodDecisionModel) is also exactly what `walletBalanceProjector` needs to
// compute a period's running balance (bootstrapped either by `WalletOpened.initialBalance`, for a
// wallet's very first period, or by that period's own `WalletStatementOpened.openingBalance`,
// carried forward from the previous period's close) - no separate "full history" balance query is
// needed anywhere in this file.

export interface ActivePeriod {
  readonly year: number;
  readonly month: number;
  readonly statementId: string;
  // The decision-model streamPosition for this (now-current) period, post any lazy statement
  // open/close - callers use this directly as their own NonCommutative/CommutativeGuarded
  // decision's streamPosition, since it already reflects everything this resolver itself just
  // appended.
  readonly streamPosition: StreamPosition;
}

interface StatementTrackingState {
  readonly openStatementId: string | null;
  readonly openYear: number | null;
  readonly openMonth: number | null;
}

const initialStatementTrackingState: StatementTrackingState = {
  openStatementId: null,
  openYear: null,
  openMonth: null
};

const statementTrackingProjector: StateProjector<StatementTrackingState> = {
  eventTypes: [WalletEvents.WALLET_STATEMENT_OPENED, WalletEvents.WALLET_STATEMENT_CLOSED],
  initialState: initialStatementTrackingState,
  transition: (state, event) => {
    if (event.type === WalletEvents.WALLET_STATEMENT_OPENED) {
      const data = event.data as WalletEvents.WalletStatementOpened;
      return { openStatementId: data.statementId, openYear: data.year, openMonth: data.month ?? null };
    }
    // WalletStatementClosed - back to "nothing open."
    return initialStatementTrackingState;
  }
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const toStatementId = (walletId: string, year: number, month: number): string => `wallet:${walletId}:${year}-${pad2(month)}`;

const oldPeriodTransactionsQuery = (walletId: string, year: number, month: number): Query.Query =>
  Query.of([
    Query.queryItemOf([WalletEvents.DEPOSIT_MADE, WalletEvents.WITHDRAWAL_MADE], [
      Tag.of(WalletTags.WALLET_ID, walletId),
      Tag.of(WalletTags.YEAR, String(year)),
      Tag.of(WalletTags.MONTH, String(month))
    ]),
    Query.queryItemOf([WalletEvents.MONEY_TRANSFERRED], [
      Tag.of(WalletTags.FROM_WALLET_ID, walletId),
      Tag.of(WalletTags.YEAR, String(year)),
      Tag.of(WalletTags.MONTH, String(month))
    ]),
    Query.queryItemOf([WalletEvents.MONEY_TRANSFERRED], [
      Tag.of(WalletTags.TO_WALLET_ID, walletId),
      Tag.of(WalletTags.YEAR, String(year)),
      Tag.of(WalletTags.MONTH, String(month))
    ])
  ]);

export const resolveActivePeriod = (
  eventStore: EventStoreService,
  walletId: string,
  now: Date = new Date()
): Effect.Effect<ActivePeriod, SqlError | ConcurrencyException, never> =>
  Effect.gen(function* () {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    const trackingQuery = Query.forEventsAndTags(
      [WalletEvents.WALLET_STATEMENT_OPENED, WalletEvents.WALLET_STATEMENT_CLOSED],
      [Tag.of(WalletTags.WALLET_ID, walletId)]
    );
    const tracking = yield* eventStore.project(trackingQuery, StreamPositionNS.zero(), [statementTrackingProjector]);

    if (
      tracking.state.openYear === year &&
      tracking.state.openMonth === month &&
      tracking.state.openStatementId !== null
    ) {
      const currentPeriodProjection = yield* eventStore.project(
        WalletQueryPatterns.singleWalletActivePeriodDecisionModel(walletId, year, month),
        StreamPositionNS.zero(),
        [walletBalanceProjector]
      );
      return {
        year,
        month,
        statementId: tracking.state.openStatementId,
        streamPosition: currentPeriodProjection.streamPosition
      };
    }

    // No statement open for the current period - lazily close the previous one (if any, and only
    // if it actually had transactions) before opening a new one.
    let carryForwardBalance = initialWalletBalanceState.balance;
    let closeStreamPosition = StreamPositionNS.zero();

    if (tracking.state.openStatementId !== null && tracking.state.openYear !== null && tracking.state.openMonth !== null) {
      const oldYear = tracking.state.openYear;
      const oldMonth = tracking.state.openMonth;
      const oldPeriodProjection = yield* eventStore.project(
        WalletQueryPatterns.singleWalletActivePeriodDecisionModel(walletId, oldYear, oldMonth),
        StreamPositionNS.zero(),
        [walletBalanceProjector]
      );
      carryForwardBalance = oldPeriodProjection.state.balance;
      closeStreamPosition = oldPeriodProjection.streamPosition;

      const hadTransactions = yield* eventStore.exists(oldPeriodTransactionsQuery(walletId, oldYear, oldMonth));
      if (hadTransactions) {
        yield* eventStore.appendNonCommutative(
          [
            WalletEvents.walletStatementClosed({
              walletId,
              statementId: tracking.state.openStatementId,
              year: oldYear,
              month: oldMonth,
              openingBalance: carryForwardBalance,
              closingBalance: carryForwardBalance,
              closedAt: now.toISOString()
            })
          ],
          trackingQuery,
          closeStreamPosition
        );
      }
    } else {
      // This wallet's very first statement ever - the opening balance comes from WalletOpened
      // itself, not from any prior period.
      const lifecycleProjection = yield* eventStore.project(
        WalletQueryPatterns.walletLifecycleModel(walletId),
        StreamPositionNS.zero(),
        [walletBalanceProjector]
      );
      carryForwardBalance = lifecycleProjection.state.balance;
    }

    const newStatementId = toStatementId(walletId, year, month);
    yield* eventStore.appendCommutative([
      WalletEvents.walletStatementOpened({
        walletId,
        statementId: newStatementId,
        year,
        month,
        openingBalance: carryForwardBalance,
        openedAt: now.toISOString()
      })
    ]);

    const freshPeriodProjection = yield* eventStore.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(walletId, year, month),
      StreamPositionNS.zero(),
      [walletBalanceProjector]
    );

    return { year, month, statementId: newStatementId, streamPosition: freshPeriodProjection.streamPosition };
  });
