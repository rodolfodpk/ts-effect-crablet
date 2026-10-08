// Decodes the wallet's STORED events with the current definitions and reports what cannot be read (ADR-0017, verify-events). Read-only.
//
//   node examples/wallet-example-app/scripts/verify-events.ts                 # a random sample of 1,000 per event type
//   node examples/wallet-example-app/scripts/verify-events.ts --all            # every event, in batches
//   node examples/wallet-example-app/scripts/verify-events.ts --from 1000000 --to 2000000 --type DepositMade
//
// Connection: WALLET_DB_HOST / _PORT / _NAME / _USER / _PASSWORD, as the app itself. Exit code 1 when anything cannot be read or a tag drifted: run it in CI
// against a copy of production data before a deploy that changes an event.
import { Effect, Redacted } from "effect";
import * as Crablet from "@crablet/commands/Crablet";
import { formatEventsReport, verifyEvents, type EventsReport } from "@crablet/commands/VerifyEvents";
import * as M from "../src/domain/WalletModel.ts";
import { WelcomeNotificationSent } from "../src/domain/notification/WelcomeNotificationSent.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const types = process.argv.flatMap((a, i) => (a === "--type" ? [process.argv[i + 1]!] : []));

// #region verify-script
const layer = Crablet.layer({
  host: process.env["WALLET_DB_HOST"] ?? "localhost",
  port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
  database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
  username: process.env["WALLET_DB_USER"] ?? "postgres",
  password: Redacted.make(process.env["WALLET_DB_PASSWORD"] ?? "postgres")
});

const program = verifyEvents({
  definitions: [M.WalletOpened, M.WalletClosed, M.WalletStatementOpened, M.WalletStatementClosed, M.DepositMade, M.WithdrawalMade, M.MoneyTransferred, WelcomeNotificationSent],
  all: process.argv.includes("--all"),
  ...(arg("sample") === undefined ? {} : { sample: Number(arg("sample")) }),
  ...(arg("from") === undefined ? {} : { fromPosition: BigInt(arg("from")!) }),
  ...(arg("to") === undefined ? {} : { toPosition: BigInt(arg("to")!) }),
  ...(types.length > 0 ? { types } : {})
});

const report = await Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<EventsReport, never, never>);
console.log(formatEventsReport(report));
process.exit(report.ok ? 0 : 1);
// #endregion verify-script
