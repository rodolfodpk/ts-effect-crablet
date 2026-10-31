// The guide "use the event store directly" (docs/guides/build), its code (support/direct-use.ts) run in memory.
import { test } from "bun:test";
import { inMemory, runWith } from "./support/direct-use.ts";
import { directUseScenario } from "./support/direct-use-scenario.ts";

// The guide's setup: one in-memory store for the whole scenario.
const layer = inMemory();
test("the guide's code, in memory: lend, refuse, return, read page by page and as a stream, a transaction that fails as a whole", () =>
  directUseScenario(runWith(layer))());
