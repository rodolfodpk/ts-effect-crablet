import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { EventStore, makeEventStoreLayer, type EventStoreConfig } from "@crablet/eventstore";
import { sessionClientsLayer } from "@crablet/eventstore/SessionClients";
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
  // A direct connection to the database for what cannot go through a pooler in transaction mode (PgBouncer): a module's leader (a session-level advisory lock) and LISTEN.
  // Give it the database's own endpoint (same shape as `pg`) while `pg` points at the pooler. Omitted, they use `pg`, as before. What its `maxConnections` must be depends on the
  // roles the process runs (`sessionHolds` below): 7 for the three modules and the api, 1 for the api alone. See docs/guides/run-in-production.md.
  readonly session?: PgConfig;
  // How many connections this process keeps in the `session` pool for good (3 leader locks at most, and one per LISTEN): 7 for all the modules and the api, 6 for the three modules without
  // the api, 2 for one module, 1 for the api alone. Given, the layer warns when `session.maxConnections` is smaller. See `sessionPoolWarning`.
  readonly sessionHolds?: number;
}

export const layer = (pg: PgConfig, options: CrabletOptions = {}): Layer.Layer<Services, SqlError> =>
  Layer.provideMerge(
    Layer.mergeAll(
      CommandExecutorLive,
      makeEventStoreLayer(options.eventStore),
      CommandAuditStoreLive,
      Layer.succeed(AuditConfigRef, { payload: options.audit?.payload ?? "redacted" }),
      options.session === undefined ? Layer.empty : sessionClientsLayer(options.session, options.sessionHolds === undefined ? {} : { holds: options.sessionHolds })
    ),
    PgClient.layer(pg)
  );
