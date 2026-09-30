import { describe, test } from "bun:test";
import { Effect } from "effect";
import { makeInMemoryEventStore } from "../src/testing/InMemoryEventStore.ts";
import { cases } from "./conformance/cases.ts";

// The in-memory store against the shared conformance cases (the same ones run against Postgres in
// test/integration/conformance-postgres.test.ts).
const store = makeInMemoryEventStore();

describe("EventStore conformance: in-memory", () => {
  for (const c of cases) {
    test(c.name, () => c.run({ run: (effect) => Effect.runPromise(Effect.provide(effect, store.layer)) }));
  }
});
