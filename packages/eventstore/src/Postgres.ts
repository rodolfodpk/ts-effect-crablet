import { Layer } from "effect";
import { PgClient } from "@effect/sql-pg";
import { makeEventStoreLayer, type EventStoreConfig } from "./EventStore.ts";

// The event store on Postgres, over a connection pool, in one layer (ADR-0052): `Postgres.layer({ host, port, database, username, password })`.
// It provides `EventStore` and keeps the database clients (`SqlClient`, `PgClient`) in its output, for code that needs them too. The database must
// have the migrations of @crablet/db-migrations applied; nothing applies them here. An entry point of its own, so `@crablet/eventstore` itself names
// no driver. The command framework's `Crablet.layer` takes the same connection.
export const layer = (pg: PgClient.PgPoolConfig, config: EventStoreConfig = {}) => Layer.provideMerge(makeEventStoreLayer(config), PgClient.layer(pg));
