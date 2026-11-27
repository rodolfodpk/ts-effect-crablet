import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { EventStore, makeEventStoreLayer, type EventStoreConfig } from "@crablet/eventstore";
import { sessionClientsLayer } from "@crablet/eventstore/SessionClients";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/commands/CommandAuditStore";
import { ProcessConnections, ProcessConnectionsLive } from "@crablet/eventstore/ProcessConnections";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { AuditConfigRef, type AuditConfig } from "@crablet/commands/CommandAudit";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { applicationNameOf, isProductName, ProcessIdentityRef, type ProcessIdentity } from "./Product.ts";

// The wiring of an application (decision V3: it moved here from @crablet/commands, which keeps the domain and the executor). Everything the framework needs, in one layer: Postgres connection in, working command executor and
// event store out.
//
//     const AppLive = Crablet.layer({
//       host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret")
//     });
//     Effect.runPromise(Effect.provide(program, AppLive));
//
// It provides `CommandExecutor`, `EventStore`, `CommandAuditStore`, the process's lock session and LISTEN connection (`ProcessConnections`, which
// the modules and the views' progress hub use) and the database clients (`SqlClient`, and `PgClient` for LISTEN/NOTIFY).
//
// Why a layer and not three `Layer.provide`s at every call site: the executor, the event store and the
// audit store all need the SAME `SqlClient`, and the clients must stay in the OUTPUT so that code
// needing them directly (a test opening its own transaction, a module needing `PgClient`) still can.
// That takes `Layer.provideMerge`; the near-identical `Layer.provide` silently drops `SqlClient` from
// the output, and the mistake only surfaces as a "service not found" at runtime, not a compile error.

export type PgConfig = PgClient.PgPoolConfig;

export type Services = CommandExecutor | EventStore | CommandAuditStore | ProcessConnections | SqlClient.SqlClient | PgClient.PgClient;

// `options.audit` sets what the command audit stores (see CommandAudit.ts): `{ payload: "redacted" | "none" | "full" | "off" }`,
// "redacted" by default.
export interface CrabletOptions {
  // How appends tell pollers about new events: `{ wakeupMode: "coalesced" | "off", wakeupWindowMs }` (see EventStoreConfig). Default: coalesced, 50 ms.
  readonly eventStore?: EventStoreConfig;
  readonly audit?: Partial<AuditConfig>;
  // A direct connection to the database for what cannot go through a pooler in transaction mode (PgBouncer): a module's leader (a session-level advisory lock) and LISTEN.
  // Give it the database's own endpoint (same shape as `pg`) while `pg` points at the pooler. Omitted, they use `pg`, as before. Its `maxConnections` must cover what the process
  // keeps for good in it, the one lock session of every module it leads (ADR-0046), plus the attempts of the modules that do not lead; its LISTENs share one connection beside the pool. The
  // framework counts the lock session as the first module starts and warns once if the pool is smaller (`holdSession`, SessionClients.ts). See docs/guides/operate/run-in-production.md.
  readonly session?: PgConfig;
  // The product this process belongs to (Product.ts): its connections are named `<product>/<instance>` (unless `pg` names them already), its modules
  // use `instance` as their instance id, and their leaders report a lock held by another product (ADR-0054: one database per product). Omitted, the
  // process has no identity, as before. `instance` defaults to `<hostname>-<pid>`.
  readonly product?: string | undefined;
  readonly instance?: string | undefined;
}

const identityOf = (options: CrabletOptions): ProcessIdentity | null => {
  if (options.product === undefined) return null;
  if (!isProductName(options.product)) throw new Error(`Crablet.layer: product "${options.product}" must be a non-empty name with no "/"`);
  return { product: options.product, instance: options.instance ?? defaultInstanceId() };
};
const named = (pg: PgConfig, identity: ProcessIdentity | null): PgConfig =>
  identity === null || pg.applicationName !== undefined ? pg : { ...pg, applicationName: applicationNameOf(identity) };

export const layer = (pg: PgConfig, options: CrabletOptions = {}): Layer.Layer<Services, SqlError> => {
  const identity = identityOf(options);
  return Layer.provideMerge(
    Layer.mergeAll(
      // The executor is built from the event store and the audit store, so it is provided with them, not merged beside them.
      Layer.provideMerge(CommandExecutorLive, Layer.mergeAll(makeEventStoreLayer(options.eventStore), CommandAuditStoreLive)),
      Layer.succeed(AuditConfigRef, { payload: options.audit?.payload ?? "redacted" }),
      // Built after the pool and closed before it: the modules and the hub built on this layer give their locks and listens back first.
      ProcessConnectionsLive,
      options.session === undefined ? Layer.empty : sessionClientsLayer(named(options.session, identity)),
      Layer.succeed(ProcessIdentityRef, identity)
    ),
    PgClient.layer(named(pg, identity))
  );
};
