import * as Tag from "@crablet/eventstore/Tag";
import * as Query from "@crablet/eventstore/Query";
import type { Query as QueryType, QueryItem } from "@crablet/eventstore/Query";
import * as WalletTags from "./WalletTags.ts";
import * as WalletEvents from "./events/WalletEvents.ts";

// Port of com.crablet.examples.wallet.WalletQueryPatterns - decision-model Query builders.
//
// Query.of([...]) items are OR'd together (a matching event satisfies *any* item) - confirmed
// against Query.ts's real shape (`packages/eventstore/src/Query.ts`) during planning, after an
// earlier draft of this port incorrectly assumed a single forEventsAndTags call could express
// "X tagged this way OR Y tagged that way." Every period-scoped query below needs that real OR,
// since a period's relevant events aren't all shaped/tagged the same way (MoneyTransferred alone
// needs two separate items per wallet - one for from_wallet_id, one for to_wallet_id).

const eventTypeItem = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag.Tag>): QueryItem =>
  Query.queryItemOf(eventTypes, tags);

// The lifecycle-only model: WalletOpened/WalletClosed for one wallet, no period scoping (opening
// and closing are one-time events, not period transactions). Used as DepositCommand's
// CommutativeGuarded lifecycle guard, and as CloseWalletCommand's own NonCommutative decision
// model.
export const walletLifecycleModel = (walletId: string): QueryType =>
  Query.forEventsAndTags([WalletEvents.WALLET_OPENED, WalletEvents.WALLET_CLOSED], [
    Tag.of(WalletTags.WALLET_ID, walletId)
  ]);

// One wallet's relevant events for a given period: its lifecycle events (always relevant, not
// period-scoped) + that period's own WalletStatementOpened (for the opening balance) + that
// period's transaction events (DepositMade/WithdrawalMade tagged wallet_id, MoneyTransferred
// tagged from_wallet_id OR to_wallet_id - two separate items, since a transfer only tags one side
// per role, never both).
const singleWalletActivePeriodItems = (walletId: string, year: number, month: number): ReadonlyArray<QueryItem> => {
  const walletTag = Tag.of(WalletTags.WALLET_ID, walletId);
  const periodTags = (roleKey: string) => [
    Tag.of(roleKey, walletId),
    Tag.of(WalletTags.YEAR, String(year)),
    Tag.of(WalletTags.MONTH, String(month))
  ];
  return [
    eventTypeItem([WalletEvents.WALLET_OPENED, WalletEvents.WALLET_CLOSED], [walletTag]),
    eventTypeItem([WalletEvents.WALLET_STATEMENT_OPENED], [
      walletTag,
      Tag.of(WalletTags.YEAR, String(year)),
      Tag.of(WalletTags.MONTH, String(month))
    ]),
    eventTypeItem([WalletEvents.DEPOSIT_MADE, WalletEvents.WITHDRAWAL_MADE], [
      walletTag,
      Tag.of(WalletTags.YEAR, String(year)),
      Tag.of(WalletTags.MONTH, String(month))
    ]),
    eventTypeItem([WalletEvents.MONEY_TRANSFERRED], periodTags(WalletTags.FROM_WALLET_ID)),
    eventTypeItem([WalletEvents.MONEY_TRANSFERRED], periodTags(WalletTags.TO_WALLET_ID))
  ];
};

// DepositCommand/WithdrawCommand's decision model: one wallet, current period.
export const singleWalletActivePeriodDecisionModel = (walletId: string, year: number, month: number): QueryType =>
  Query.of(singleWalletActivePeriodItems(walletId, year, month));

// TransferMoneyCommand's decision model: both wallets' relevant events for the current period,
// unioned - built by reusing singleWalletActivePeriodItems for each side rather than duplicating
// the item-construction logic. Some MoneyTransferred items end up redundant across the two calls
// (a transfer between the same two wallets could theoretically match twice) - harmless, Postgres
// just OR-matches the same event via multiple items with no correctness impact, only a slightly
// wider query than a hand-deduplicated one would be.
export const transferPeriodDecisionModel = (
  fromWalletId: string,
  toWalletId: string,
  year: number,
  month: number
): QueryType =>
  Query.of([
    ...singleWalletActivePeriodItems(fromWalletId, year, month),
    ...singleWalletActivePeriodItems(toWalletId, year, month)
  ]);
