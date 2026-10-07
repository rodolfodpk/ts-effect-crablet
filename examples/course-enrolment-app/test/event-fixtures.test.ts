// Every shape the course events have been written in must stay readable, and their tags stable (ADR-0017). See the wallet's test for how to change an event.
import { describe, test } from "bun:test";
import path from "node:path";
import { assertEventFixtures, loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import { CourseDefined, StudentSubscribed } from "../src/domain/Enrolment.ts";

describe("the course events", () => {
  test("every stored shape still decodes, derives the tags it was stored with, and every event type has a fixture", () => {
    assertEventFixtures({
      definitions: [CourseDefined, StudentSubscribed],
      fixtures: loadEventFixtures(path.join(import.meta.dir, "fixtures/events")),
      requireCoverage: true
    });
  });
});
