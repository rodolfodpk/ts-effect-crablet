// The guide "use the event store directly" (docs/guides/build), its code (support/direct-use.ts) run in memory.
import { test } from "bun:test";
import { Effect } from "effect";
import { makeInMemoryEventStore } from "../src/testing/InMemoryEventStore.ts";
import type { EventStore } from "../src/EventStore.ts";
import { directUseScenario } from "./support/direct-use-scenario.ts";

const store = makeInMemoryEventStore();
test("the guide's code, in memory: lend, refuse, return, read page by page and as a stream, a transaction that fails as a whole", () =>
  directUseScenario(<A, E>(effect: Effect.Effect<A, E, EventStore>) => Effect.runPromise(Effect.provide(effect, store.layer)))());
