import type { StateProjector, StoredEvent } from "@crablet/eventstore";
import * as WalletEvents from "./events/WalletEvents.ts";

// Port of com.crablet.examples.wallet.projections.WalletBalanceState /
// WalletBalanceStateProjector - an in-memory DCB decision-model projector (not a materialized
// view), shared by every command handler that needs to check "does this wallet exist" /
// "does it have sufficient funds", and by WalletStatementPeriodResolver.ts to stamp opening/
// closing balances onto lazily-appended statement events.
//
// `exists` becomes true only on WalletOpened, false again on WalletClosed (tombstone - balance
// stays frozen at its last known value). WalletStatementOpened sets balance but *preserves* the
// existing `exists` flag - it's not a lifecycle event.
export interface WalletBalanceState {
  readonly exists: boolean;
  readonly balance: number;
}

export const initialWalletBalanceState: WalletBalanceState = { exists: false, balance: 0 };

export const hasSufficientFunds = (state: WalletBalanceState, amount: number): boolean =>
  state.exists && state.balance >= amount;

const transition = (state: WalletBalanceState, event: StoredEvent): WalletBalanceState => {
  switch (event.type) {
    case WalletEvents.WALLET_OPENED: {
      const data = event.data as WalletEvents.WalletOpened;
      return { exists: true, balance: data.initialBalance };
    }
    case WalletEvents.WALLET_CLOSED:
      return { ...state, exists: false };
    case WalletEvents.DEPOSIT_MADE:
      return { ...state, balance: (event.data as WalletEvents.DepositMade).newBalance };
    case WalletEvents.WITHDRAWAL_MADE:
      return { ...state, balance: (event.data as WalletEvents.WithdrawalMade).newBalance };
    case WalletEvents.MONEY_TRANSFERRED: {
      const data = event.data as WalletEvents.MoneyTransferred;
      const isFromSide = event.tags.some((t) => t.key === "from_wallet_id");
      return { ...state, balance: isFromSide ? data.fromBalance : data.toBalance };
    }
    case WalletEvents.WALLET_STATEMENT_OPENED:
      // Sets the running balance to this period's opening balance (matches the balance carried
      // forward from the prior period's close), but is NOT a lifecycle event - `exists` untouched.
      return { ...state, balance: (event.data as WalletEvents.WalletStatementOpened).openingBalance };
    default:
      return state;
  }
};

export const walletBalanceProjector: StateProjector<WalletBalanceState> = {
  eventTypes: [
    WalletEvents.WALLET_OPENED,
    WalletEvents.WALLET_CLOSED,
    WalletEvents.DEPOSIT_MADE,
    WalletEvents.WITHDRAWAL_MADE,
    WalletEvents.MONEY_TRANSFERRED,
    WalletEvents.WALLET_STATEMENT_OPENED
  ],
  initialState: initialWalletBalanceState,
  transition
};
