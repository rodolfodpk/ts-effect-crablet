import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { EventStore, makeEventStoreLayer, type EventStoreConfig } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "./CommandExecutor.ts";
import { AuditConfigRef, type AuditConfig } from "./CommandAudit.ts";

// Everything the framework needs, in one layer: Postgres connection in, working command executor and
// event store out.
//
//     const AppLive = Crablet.layer({
//       host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret")
//     });
//     Effect.runPromise(Effect.provide(program, AppLive));
//
// It provides `CommandExecutor`, `EventStore`, `CommandAuditStore` and the database clients
// (`SqlClient`, and `PgClient` for LISTEN/NOTIFY - which views, outbox and automations modules need).
//
// Why a layer and not three `Layer.provide`s at every call site: the executor, the event store and the
// audit store all need the SAME `SqlClient`, and the clients must stay in the OUTPUT so that code
// needing them directly (a test opening its own transaction, a module needing `PgClient`) still can.
// That takes `Layer.provideMerge`; the near-identical `Layer.provide` silently drops `SqlClient` from
// the output, and the mistake only surfaces as a "service not found" at runtime, not a compile error.

export type PgConfig = Parameters<typeof PgClient.layer>[0];

export type Services = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient;

// `options.audit` sets what the command audit stores (see CommandAudit.ts): `{ payload: "redacted" | "none" | "full" | "off" }`,
// "redacted" by default.
export interface CrabletOptions {
  // How appends tell pollers about new events: `{ wakeupMode: "coalesced" | "inline" | "off", wakeupWindowMs }` (see EventStoreConfig). Default: coalesced, 50 ms.
  readonly eventStore?: EventStoreConfig;
  readonly audit?: Partial<AuditConfig>;
}

export const layer = (pg: PgConfig, options: CrabletOptions = {}): Layer.Layer<Services, SqlError> =>
  Layer.provideMerge(
    Layer.mergeAll(
      CommandExecutorLive,
      makeEventStoreLayer(options.eventStore),
      CommandAuditStoreLive,
      Layer.succeed(AuditConfigRef, { payload: options.audit?.payload ?? "redacted" })
    ),
    PgClient.layer(pg)
  );
