// How much space the wallet's database spends on the library's tables (ADR-0019). Read-only, from the catalog: no table is scanned.
//
//   node examples/wallet-example-app/scripts/report-storage.ts            # estimates (as fresh as the last autovacuum or ANALYZE)
//   node examples/wallet-example-app/scripts/report-storage.ts --exact    # also counts the events table
//
// Connection: WALLET_DB_HOST / _PORT / _NAME / _USER / _PASSWORD, as the app itself. In a running application keep the gauges current instead:
//   yield* Effect.forkDetach(monitorStorage({ every: "5 minutes" }))   // from @crablet/eventstore/Storage
import { Effect, Redacted } from "effect";
import * as Crablet from "@crablet/commands/Crablet";
import { formatStorageReport, storageReport, type StorageReport } from "@crablet/eventstore/Storage";

const layer = Crablet.layer({
  host: process.env["WALLET_DB_HOST"] ?? "localhost",
  port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
  database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
  username: process.env["WALLET_DB_USER"] ?? "postgres",
  password: Redacted.make(process.env["WALLET_DB_PASSWORD"] ?? "postgres")
});

const report = await Effect.runPromise(Effect.provide(storageReport({ exact: process.argv.includes("--exact") }), layer) as Effect.Effect<StorageReport, never, never>);
console.log(formatStorageReport(report));
process.exit(0);
