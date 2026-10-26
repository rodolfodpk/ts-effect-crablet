import { Duration, Effect } from "effect";
import type { SqlClient } from "effect/sql";

// A pod cut off in the middle of a transaction (a command's, a view batch's: a silent partition, no FIN, no RST) leaves its server session idle in
// transaction, and no view, automation, publisher or deadline gets past an open transaction (no event is delivered while an older transaction is open:
// that is what makes "no event is skipped" true). They all wait until the server ends that session: after `idle_in_transaction_session_timeout`, or,
// with it at 0 (off, the default, and RDS's and Aurora's), when its TCP keepalives give up, minutes with a managed database's settings. Measured in
// views/test/integration/zombie-transaction.test.ts. The leader's own session ends itself (ADR-0045); this is every other session.
//
// The setting belongs on the server (a parameter group, or `ALTER ROLE`), not in the connection's startup parameters: a pooler such as PgBouncer
// refuses startup parameters it does not know. So the framework does not set it; it says so when it is off.
export const idleInTransactionWarning = (setting: string): string | null =>
  setting.trim() === "0"
    ? "idle_in_transaction_session_timeout is 0 (off): a pod cut off in the middle of a transaction stalls every view, automation, publisher and deadline until the server ends its session, minutes with TCP keepalives. Set it on the server, 15s to start from (in the parameter group, or ALTER ROLE <app> SET idle_in_transaction_session_timeout = '15s'); see docs/guides/operate/configure.md."
    : null;

// The clients already checked, or being checked: the check runs once per client (a process's modules share one), when the first module tries for its
// lock. A failed read is not a finding: it is forgotten, and the next attempt reads again. It is bounded, so a database that does not answer does not hold the
// leader's first attempt longer than 5 s; an interrupted read is forgotten too.
const checked = new WeakMap<SqlClient.SqlClient, true>();

// Read the setting the application's sessions run with (the server's, a role's, or a startup parameter's), and warn once if it is off.
export const checkIdleInTransactionOnce = (sql: SqlClient.SqlClient): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (checked.has(sql)) return Effect.void;
    checked.set(sql, true);
    return sql<{ readonly value: string }>`SELECT current_setting('idle_in_transaction_session_timeout') AS value`.pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.flatMap((rows) => {
        const warning = rows[0] === undefined ? null : idleInTransactionWarning(rows[0].value);
        return warning === null ? Effect.void : Effect.logWarning(warning);
      }),
      Effect.onError(() => Effect.sync(() => void checked.delete(sql))),
      Effect.catch(() => Effect.void)
    );
  });
