// The change-impact report for the course models (ADR-0017, DCB rule A): every event that carries a model's binding tag is handled, ignored, or accepted in the baseline
// with a reason (the course-start events, which the seats model does not need).
// If an event is added that carries course_id or student_id, this test names the model that has not accounted for it.
import { describe, test } from "bun:test";
import path from "node:path";
import { loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import { assertModelImpact, eventFactsFromFixtures, modelFactsOf } from "@crablet/commands/ModelImpact";
import { CourseDefined, CourseModel, StudentModel, StudentSubscribed } from "../src/domain/Enrolment.ts";
import { CourseConfirmed, CourseReadiness, RoomBooked, TeacherAssigned } from "../src/domain/CourseStart.ts";

describe("the course decision models", () => {
  test("every event type that carries a model's binding tag is accounted for", () => {
    assertModelImpact({
      events: eventFactsFromFixtures([CourseDefined, StudentSubscribed, TeacherAssigned, RoomBooked, CourseConfirmed], loadEventFixtures(path.join(import.meta.dir, "fixtures/events"))),
      models: [modelFactsOf("CourseModel", CourseModel.of({ id: "c" })), modelFactsOf("StudentModel", StudentModel.of({ id: "s" })), modelFactsOf("CourseReadiness", CourseReadiness.of({ id: "c" }))],
      baselineFile: path.join(import.meta.dir, "fixtures/model-impact-baseline.json")
    });
  });
});
