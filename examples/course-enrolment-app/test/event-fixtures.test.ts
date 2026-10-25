// Every shape the course events have been written in must stay readable, and their tags stable (ADR-0017). See the wallet's test for how to change an event.
import { describe, test } from "bun:test";
import path from "node:path";
import { assertEventFixtures, loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import { CourseCancelled, CourseDefined, StudentSubscribed, SubscriptionReleased } from "../src/domain/Enrolment.ts";
import { CoursePriced, ReceiptSent, ReleaseUnpaidSubscription, SubscriptionPaid } from "../src/domain/Payments.ts";
import { CancelUnreadyCourse, CourseConfirmed, RoomBooked, TeacherAssigned } from "../src/domain/CourseStart.ts";

describe("the course events", () => {
  test("every stored shape still decodes, derives the tags it was stored with, and every event type and deadline command has a fixture", () => {
    assertEventFixtures({
      definitions: [CourseDefined, StudentSubscribed, SubscriptionReleased, CourseCancelled, TeacherAssigned, RoomBooked, CourseConfirmed, CoursePriced, SubscriptionPaid, ReceiptSent],
      fixtures: loadEventFixtures(path.join(import.meta.dir, "fixtures/events")),
      // The deadlines Subscribe and DefineCourse set store these commands' inputs: they must stay readable too.
      deadlineCommands: [ReleaseUnpaidSubscription, CancelUnreadyCourse],
      requireCoverage: true
    });
  });
});
