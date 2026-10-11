// Is the data consistent? Checks that need no knowledge of what the load did: they read the event log and compare what the rest of the system built from it. They are meant to run after the load
// was paused and the processors caught up (server.ts does that first); on a moving system a mismatch can be a read between two commits.
//
// The wallet's own rules decide what to check. Credits are `concurrent` (deposits commute with everything but a close), so the balance an event records is a snapshot of the moment it was decided and
// may be stale BY DESIGN (a debit is strict, so its own recorded balance is exact; a credit is not). That is reported as information. What must hold is on the log itself: the sum of the moves,
// never negative; and whatever is built from the log (the views) must agree with that sum, which a projection that copies the recorded snapshot instead of applying the amount does not.
import type { Client } from "pg";
import type { Check } from "../src/contract.ts";

// Every change of a balance, in the order the event store orders events: (transaction_id, position).
const MOVES = `
  WITH moves AS (
    SELECT transaction_id, position, type, data->>'walletId' AS wallet_id, (data->>'initialBalance')::numeric AS delta, (data->>'initialBalance')::numeric AS recorded, false AS debit
      FROM crablet_events WHERE type = 'WalletOpened'
    UNION ALL SELECT transaction_id, position, type, data->>'walletId', (data->>'amount')::numeric, (data->>'newBalance')::numeric, false FROM crablet_events WHERE type = 'DepositMade'
    UNION ALL SELECT transaction_id, position, type, data->>'walletId', -(data->>'amount')::numeric, (data->>'newBalance')::numeric, true FROM crablet_events WHERE type = 'WithdrawalMade'
    UNION ALL SELECT transaction_id, position, type, data->>'fromWalletId', -(data->>'amount')::numeric, (data->>'fromBalance')::numeric, true FROM crablet_events WHERE type = 'MoneyTransferred'
    UNION ALL SELECT transaction_id, position, type, data->>'toWalletId', (data->>'amount')::numeric, (data->>'toBalance')::numeric, false FROM crablet_events WHERE type = 'MoneyTransferred'
  ), running AS (
    SELECT *, sum(delta) OVER (PARTITION BY wallet_id ORDER BY transaction_id, position) AS balance FROM moves
  )`;

const n = (value: unknown): number => Number(value);
const plural = (count: number, word: string): string => `${count.toLocaleString("en")} ${word}${count === 1 ? "" : "s"}`;

export const dataChecks = async (client: Client): Promise<ReadonlyArray<Check>> => {
  const one = async (sql: string): Promise<Record<string, unknown>> => (await client.query(sql)).rows[0] as Record<string, unknown>;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, info = false) => checks.push({ name, ok, detail, info });

  const totals = await one(`SELECT (SELECT count(*) FROM crablet_events) AS events, (SELECT count(*) FROM crablet_commands) AS commands,
                                   (SELECT count(*) FROM crablet_events WHERE type = 'WalletOpened') AS wallets`);
  add("What is in the log", true, `${plural(n(totals["events"]), "event")}, ${plural(n(totals["commands"]), "command")}, ${plural(n(totals["wallets"]), "wallet")}`, true);

  // 1. the balance view is the sum of the log
  const balance = await one(`${MOVES}, totals AS (SELECT wallet_id, sum(delta) AS bal FROM moves GROUP BY 1)
    SELECT count(*) AS wallets, count(*) FILTER (WHERE v.wallet_id IS NULL) AS missing, count(*) FILTER (WHERE v.balance <> t.bal) AS different,
           (SELECT count(*) FROM wallet_balance_view v2 WHERE NOT EXISTS (SELECT 1 FROM totals t2 WHERE t2.wallet_id = v2.wallet_id)) AS extra
      FROM totals t LEFT JOIN wallet_balance_view v USING (wallet_id)`);
  add(
    "The balance view equals the sum of the log",
    n(balance["missing"]) === 0 && n(balance["different"]) === 0 && n(balance["extra"]) === 0,
    `${plural(n(balance["wallets"]), "wallet")} compared: ${n(balance["missing"])} missing from the view, ${n(balance["different"])} with another balance, ${n(balance["extra"])} in the view and not in the log`
  );

  // 2. so is the summary view
  const summary = await one(`${MOVES}, totals AS (SELECT wallet_id, sum(delta) AS bal FROM moves GROUP BY 1)
    SELECT count(*) FILTER (WHERE s.wallet_id IS NULL) AS missing, count(*) FILTER (WHERE s.current_balance <> t.bal) AS different FROM totals t LEFT JOIN wallet_summary_view s USING (wallet_id)`);
  add("The summary view equals the sum of the log", n(summary["missing"]) === 0 && n(summary["different"]) === 0, `${n(summary["missing"])} wallets missing from the view, ${n(summary["different"])} with another balance`);

  // 3. nobody was overdrawn
  const negative = await one(`${MOVES} SELECT count(*) AS bad, count(DISTINCT wallet_id) AS wallets FROM running WHERE balance < 0`);
  add("No wallet was ever overdrawn", n(negative["bad"]) === 0, `${plural(n(negative["bad"]), "moment")} with a negative balance, in ${plural(n(negative["wallets"]), "wallet")}`);

  // 5. nothing happened twice
  const dupes = await one(`SELECT (SELECT count(*) FROM (SELECT 1 FROM crablet_events WHERE type = 'DepositMade' GROUP BY data->>'depositId' HAVING count(*) > 1) a) AS deposits,
                                  (SELECT count(*) FROM (SELECT 1 FROM crablet_events WHERE type = 'WithdrawalMade' GROUP BY data->>'withdrawalId' HAVING count(*) > 1) b) AS withdrawals,
                                  (SELECT count(*) FROM (SELECT 1 FROM crablet_events WHERE type = 'MoneyTransferred' GROUP BY data->>'transferId' HAVING count(*) > 1) c) AS transfers`);
  const dup = n(dupes["deposits"]) + n(dupes["withdrawals"]) + n(dupes["transfers"]);
  add("No deposit, withdrawal or transfer happened twice", dup === 0, `${n(dupes["deposits"])} repeated deposit ids, ${n(dupes["withdrawals"])} withdrawal ids, ${n(dupes["transfers"])} transfer ids`);

  // 6. the automation: one welcome notification per wallet, exactly
  const welcome = await one(`SELECT count(*) AS wallets, count(*) FILTER (WHERE w.sent <> 1) AS wrong FROM
      (SELECT o.data->>'walletId' AS wallet_id, (SELECT count(*) FROM crablet_events s WHERE s.type = 'WelcomeNotificationSent' AND s.data->>'walletId' = o.data->>'walletId') AS sent
         FROM crablet_events o WHERE o.type = 'WalletOpened') w`);
  add("Every wallet got exactly one welcome notification", n(welcome["wrong"]) === 0, `${plural(n(welcome["wallets"]), "wallet")}, ${n(welcome["wrong"])} with none or more than one`);

  // 7. every transaction of events has its command in the audit, and the other way round
  const audit = await one(`SELECT (SELECT count(DISTINCT transaction_id) FROM crablet_events) AS event_transactions, (SELECT count(*) FROM crablet_commands) AS commands,
      (SELECT count(*) FROM crablet_commands c WHERE NOT EXISTS (SELECT 1 FROM crablet_events e WHERE e.transaction_id = c.transaction_id)) AS commands_without_events,
      (SELECT count(DISTINCT e.transaction_id) FROM crablet_events e WHERE NOT EXISTS (SELECT 1 FROM crablet_commands c WHERE c.transaction_id = e.transaction_id)) AS events_without_command`);
  add(
    "Every transaction of events has one command in the audit",
    n(audit["commands_without_events"]) === 0 && n(audit["events_without_command"]) === 0 && n(audit["event_transactions"]) === n(audit["commands"]),
    `${plural(n(audit["event_transactions"]), "transaction")} of events, ${plural(n(audit["commands"]), "audited command")}, ${n(audit["commands_without_events"])} commands with no events, ${n(audit["events_without_command"])} transactions with no command`
  );

  // 8. the transaction view has a row per move of money
  const txView = await one(`SELECT (SELECT count(*) FROM wallet_transaction_view) AS rows,
      (SELECT count(*) FROM crablet_events WHERE type IN ('DepositMade', 'WithdrawalMade')) + 2 * (SELECT count(*) FROM crablet_events WHERE type = 'MoneyTransferred') AS expected`);
  add("The transaction view has a row for every move of money", n(txView["rows"]) === n(txView["expected"]), `${plural(n(txView["rows"]), "row")} in the view, ${plural(n(txView["expected"]), "row")} from the log`);

  // 9. the balance a statement opens or closes with is the sum of the wallet's moves before that event. A late deposit that slips into a month after it was closed, or a period turned from a stale state, shows here.
  // (Closed statements exist only once a month has turned: a lab that runs inside one month compares the opening balances only.)
  const statements = await client.query(`
    WITH moves AS MATERIALIZED (
      SELECT transaction_id, position, data->>'walletId' AS wallet_id, (data->>'initialBalance')::numeric AS delta FROM crablet_events WHERE type = 'WalletOpened'
      UNION ALL SELECT transaction_id, position, data->>'walletId', (data->>'amount')::numeric FROM crablet_events WHERE type = 'DepositMade'
      UNION ALL SELECT transaction_id, position, data->>'walletId', -(data->>'amount')::numeric FROM crablet_events WHERE type = 'WithdrawalMade'
      UNION ALL SELECT transaction_id, position, data->>'fromWalletId', -(data->>'amount')::numeric FROM crablet_events WHERE type = 'MoneyTransferred'
      UNION ALL SELECT transaction_id, position, data->>'toWalletId', (data->>'amount')::numeric FROM crablet_events WHERE type = 'MoneyTransferred'
    ), edges AS (
      SELECT type, transaction_id, position, data->>'walletId' AS wallet_id, data->>'statementId' AS statement_id,
             CASE type WHEN 'WalletStatementOpened' THEN (data->>'openingBalance')::numeric ELSE (data->>'closingBalance')::numeric END AS recorded
        FROM crablet_events WHERE type IN ('WalletStatementOpened', 'WalletStatementClosed')
    ), compared AS (
      SELECT e.*, (SELECT coalesce(sum(m.delta), 0) FROM moves m WHERE m.wallet_id = e.wallet_id AND (m.transaction_id, m.position) < (e.transaction_id, e.position)) AS expected FROM edges e
    )
    SELECT c.type, count(*) AS total, count(*) FILTER (WHERE c.recorded <> c.expected) AS wrong,
           -- the statement view must hold the same balance: a row that is missing, or has another balance (or none yet), is wrong
           count(*) FILTER (WHERE v.statement_id IS NULL OR (CASE c.type WHEN 'WalletStatementOpened' THEN v.opening_balance ELSE v.closing_balance END) IS DISTINCT FROM c.expected) AS view_wrong
      FROM compared c LEFT JOIN wallet_statement_view v ON v.statement_id = c.statement_id GROUP BY 1`);
  const edge = (type: string) => statements.rows.find((r: Record<string, unknown>) => r["type"] === type) as Record<string, unknown> | undefined;
  const opened = n(edge("WalletStatementOpened")?.["total"] ?? 0), closed = n(edge("WalletStatementClosed")?.["total"] ?? 0);
  const wrongEdges = n(edge("WalletStatementOpened")?.["wrong"] ?? 0) + n(edge("WalletStatementClosed")?.["wrong"] ?? 0);
  const wrongInView = n(edge("WalletStatementOpened")?.["view_wrong"] ?? 0) + n(edge("WalletStatementClosed")?.["view_wrong"] ?? 0);
  add(
    "A statement opens and closes with the sum of the log, and its view says the same",
    wrongEdges === 0 && wrongInView === 0,
    `${plural(opened, "statement")} opened and ${closed} closed${closed === 0 ? " (no month has turned yet)" : ""}: ${wrongEdges} with an opening or closing balance other than the sum of the wallet's moves before it, ${wrongInView} missing from the statement view or held there with another balance`
  );

  // for information: events whose recorded balance is not the running sum, which is allowed (a credit committed between the decision and the append)
  const stale = await one(`${MOVES} SELECT count(*) FILTER (WHERE type = 'DepositMade') AS deposits, count(*) FILTER (WHERE type = 'DepositMade' AND recorded <> balance) AS stale_deposits,
                                   count(*) FILTER (WHERE debit) AS debits, count(*) FILTER (WHERE debit AND recorded <> balance) AS stale_debits FROM running`);
  add(
    "Events that recorded a balance other than the running sum",
    true,
    `${n(stale["stale_deposits"])} of ${plural(n(stale["deposits"]), "deposit")} and ${n(stale["stale_debits"])} of ${plural(n(stale["debits"]), "debit")}: allowed, a credit can commit between the decision and the append. A view that copies this number instead of applying the amount gets the wrong balance`,
    true
  );
  return checks;
};
