import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import { EventStore, makeEventStoreLayer, type EventStoreConfig } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/commands/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "../../src/CommandExecutor.ts";
import { AuditConfigRef, type AuditConfig } from "../../src/CommandAudit.ts";

// The services this package's integration tests run commands with, built from this package's own parts. An application gets them from `@crablet/app`'s
// `Crablet.layer`; this package cannot depend on that one, which is built on it (decision V3). `test/integration/crablet-layer.test.ts` in @crablet/app
// tests the real wiring.
export type Services = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient;

export const layer = (
  pg: PgClient.PgPoolConfig,
  options: { readonly eventStore?: EventStoreConfig; readonly audit?: Partial<AuditConfig> } = {}
): Layer.Layer<Services, SqlError> =>
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.provideMerge(CommandExecutorLive, Layer.mergeAll(makeEventStoreLayer(options.eventStore), CommandAuditStoreLive)),
      Layer.succeed(AuditConfigRef, { payload: options.audit?.payload ?? "redacted" })
    ),
    PgClient.layer(pg)
  );
