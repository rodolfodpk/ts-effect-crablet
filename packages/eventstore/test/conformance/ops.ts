// Shared operations for the conformance cases and the differential test: a harness that runs effects
// against some EventStore, and small helpers to append, read and build events/queries.
import { Effect } from "effect";
import { EventStore, type StoredEvent } from "../../src/EventStore.ts";
import type * as AppendCondition from "../../src/AppendCondition.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import type { LogPosition as LogPositionType } from "../../src/LogPosition.ts";

export interface Harness {
  readonly run: <A, E>(effect: Effect.Effect<A, E, EventStore>) => Promise<A>;
}
export interface ConformanceCase {
  readonly name: string;
  readonly run: (h: Harness) => Promise<void>;
}

export const uid = () => crypto.randomUUID().replaceAll("-", "");
export const ev = (type: string, tags: ReadonlyArray<readonly [string, string]> = [], data: unknown = { n: 1 }) =>
  AppendEvent.builder(type).tags(tags.map(([k, v]) => Tag.of(k, v))).data(data).build();
export const item = (types: ReadonlyArray<string>, tags: ReadonlyArray<readonly [string, string]> = []) =>
  Query.queryItemOf(types, tags.map(([k, v]) => Tag.of(k, v)));

export type Outcome = "ok" | "conflict" | "duplicate";
export const append = (h: Harness, events: ReadonlyArray<AppendEvent.AppendEvent>, condition?: AppendCondition.AppendCondition): Promise<Outcome> =>
  h.run(
    Effect.flatMap(EventStore, (es) =>
      (condition === undefined ? es.append(events) : es.append(events, condition)).pipe(
        Effect.map((): Outcome => "ok"),
        Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const)),
        Effect.catchTag("Duplicate", () => Effect.succeed("duplicate" as const))
      )
    )
  );

// Every event a query matches after `after`, in the order `project` yields them, plus the final position.
export const read = (h: Harness, query: Query.Query, after: LogPositionType = LogPosition.zero()) =>
  h.run(
    Effect.flatMap(EventStore, (es) =>
      es.project(query, after, [
        {
          eventTypes: [],
          initialState: [] as ReadonlyArray<StoredEvent>,
          transition: (events: ReadonlyArray<StoredEvent>, e: StoredEvent) => [...events, e]
        }
      ])
    )
  );
export const positionOf = async (h: Harness, query: Query.Query) => (await read(h, query)).logPosition;
export const headPosition = async (h: Harness) => (await read(h, Query.of([]))).logPosition; // everything matches
export const existsQuery = (h: Harness, query: Query.Query) => h.run(Effect.flatMap(EventStore, (es) => es.exists(query)));
export const tagStrings = (e: StoredEvent) => e.tags.map((t) => `${t.key}=${t.value}`).sort();

