// The change-impact report for the course models (ADR-0017, DCB rule A): every event that carries a model's binding tag is handled, ignored, or accepted in the baseline
// with a reason (the course-start and payment events, which the seats, student and pricing models do not need).
// If an event is added that carries course_id or student_id, this test names the model that has not accounted for it.
import { describe, test } from "bun:test";
import path from "node:path";
import { loadEventFixtures } from "@crablet/commands/testing/EventFixtures";
import { assertModelImpact, eventFactsFromFixtures, modelFactsOf } from "@crablet/commands/ModelImpact";
import { CourseCancelled, CourseDefined, CourseModel, StudentModel, StudentSubscribed, SubscriptionReleased } from "../src/domain/Enrolment.ts";
import { CoursePriced, CoursePricing, ReceiptSent, SubscriptionModel, SubscriptionPaid } from "../src/domain/Payments.ts";
import { CourseConfirmed, CourseReadiness, RoomBooked, TeacherAssigned } from "../src/domain/CourseStart.ts";
import { BillingModel, BillingStarted, BillingStopped, InvoiceIssued, InvoiceModel, InvoiceOverdue, InvoicePaid } from "../src/features/monthly-fee/index.ts";

describe("the course decision models", () => {
  test("every event type that carries a model's binding tag is accounted for", () => {
    assertModelImpact({
      events: eventFactsFromFixtures([CourseDefined, StudentSubscribed, SubscriptionReleased, CourseCancelled, TeacherAssigned, RoomBooked, CourseConfirmed, CoursePriced, SubscriptionPaid, ReceiptSent,
        BillingStarted, InvoiceIssued, InvoicePaid, InvoiceOverdue, BillingStopped], loadEventFixtures(path.join(import.meta.dir, "fixtures/events"))),
      models: [modelFactsOf("CourseModel", CourseModel.of({ id: "c" })), modelFactsOf("StudentModel", StudentModel.of({ id: "s" })), modelFactsOf("CourseReadiness", CourseReadiness.of({ id: "c" })),
        modelFactsOf("CoursePricing", CoursePricing.of({ id: "c" })),
        modelFactsOf("SubscriptionModel", SubscriptionModel.of({ id: "s", courseId: "c" })),
        modelFactsOf("BillingModel", BillingModel.of({ id: "b" })), modelFactsOf("InvoiceModel", InvoiceModel.of({ id: "b#1" }))],
      baselineFile: path.join(import.meta.dir, "fixtures/model-impact-baseline.json")
    });
  });
});
