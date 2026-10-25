# Aggregate events

*Guide · developers · [Add an automation](add-an-automation.md) done · 15 minutes*

Sometimes something should happen only once several other things have: a course starts when it has a teacher, a room and three students, and
those arrive in any order, from different commands. In [Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/) this is an
**Aggregator**. An Aggregator usually keeps the groups it has started in a store of its own. Here it needs none: the events are already in the log, and
a **model** folds them. So there is nothing new to configure: a model, a command and an automation make one, and a view shows what each group is still
missing. The example is the course app's course start.

[← Task guides](../README.md)

## The Aggregator, part by part

EIP describes an Aggregator by four things. Three map onto what a command already is; the fourth is [a deadline](#stop-waiting-a-deadline).

| Aggregator | Here | In the example |
|---|---|---|
| **Correlation**: which messages belong together | a tag every event carries, the model's `by` | `course_id` |
| **Completeness condition**: when the group is complete | `decide` | a teacher, a room, and at least 3 students |
| **Aggregation**: what to publish once it is | the event `decide` emits | `CourseConfirmed`, with the teacher, the room and the count |
| **Expiry**: when to stop waiting | a deadline the first decision sets, whose command decides what an incomplete group becomes | `CancelUnreadyCourse`, 14 days after `DefineCourse` ([below](#stop-waiting-a-deadline)) |

What the log does in place of the Aggregator's store:

- **No partial groups to keep.** The group is a fold of the events in the log, so it cannot be lost in a crash, needs no clean-up, and a change to the
  model applies to groups already started. A replay gives the same answer.
- **The order of delivery does not matter.** The command reads the log, which can be ahead of the delivery that woke it: when the second of five events is
  delivered, all five may already be in the log, and that run confirms the course. The ones after it answer "already confirmed".
- **Exactly one aggregate.** The command's boundary is the group's events, so two runs that race append one `CourseConfirmed`: the second conflicts,
  re-runs on fresh state, and sees it. A redelivered event is a repeat the model recognises (`byModel()`).

## 1. Events that carry the correlation

Each event is tagged with what correlates it, here the course. `TeacherAssigned` and `RoomBooked` are new; the third kind is the existing
`StudentSubscribed`, which is tagged with the course too. `CourseConfirmed` is the aggregate.

<!-- file: examples/course-enrolment-app/src/domain/CourseStart.ts#events -->
```ts
// Facts that arrive in any order, from different commands, about one course: the `course_id` tag correlates them. The third kind is
// StudentSubscribed (Enrolment.ts), counted until the course has enough students.
export const TeacherAssigned = defineEvent("TeacherAssigned", {
  schema: Schema.Struct({ courseId: Schema.String, teacherId: Schema.String }),
  tags: (d) => ({ course_id: d.courseId })
});
export const RoomBooked = defineEvent("RoomBooked", {
  schema: Schema.Struct({ courseId: Schema.String, room: Schema.String }),
  tags: (d) => ({ course_id: d.courseId })
});

// What is published once all of them are there: the aggregate.
export const CourseConfirmed = defineEvent("CourseConfirmed", {
  schema: Schema.Struct({ courseId: Schema.String, teacherId: Schema.String, room: Schema.String, students: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
```

New event types that carry a tag an existing model binds through are reported by the change-impact test (the course's seat model binds `course_id` too):
handle them, `.ignores(...)` them, or accept them with a reason, as [`model-impact-baseline.json`](../../../examples/course-enrolment-app/test/fixtures/model-impact-baseline.json)
does here ([Evolving events](evolving-events.md)).

## 2. The model is the group

One `.on` per kind of event, and one for the aggregate itself, so the model knows the group is done. `.ignores(CourseDefined)` says the course's
definition carries the tag but does not matter to its start.

<!-- file: examples/course-enrolment-app/src/domain/CourseStart.ts#model -->
```ts
// The aggregator's state: what has arrived for one course so far. It is a fold of events already in the log, so there is no store of
// partial groups to keep, clean up or migrate, and the order they arrive in does not matter.
export const CourseReadiness = defineModel({
  by: "course_id",
  initial: () => ({
    teacherId: null as string | null,
    room: null as string | null,
    studentIds: [] as ReadonlyArray<string>,
    status: "waiting" as "waiting" | "confirmed" | "cancelled"
  })
})
  .on(TeacherAssigned, (s, d) => ({ ...s, teacherId: d.teacherId }))
  .on(RoomBooked, (s, d) => ({ ...s, room: d.room }))
  .on(StudentSubscribed, (s, d) => ({ ...s, studentIds: [...s.studentIds, d.studentId] }))
  .on(SubscriptionReleased, (s, d) => ({ ...s, studentIds: s.studentIds.filter((id) => id !== d.studentId) }))
  .on(CourseConfirmed, (s) => ({ ...s, status: "confirmed" as const }))
  .on(CourseCancelled, (s) => ({ ...s, status: "cancelled" as const }))
  .ignores(CourseDefined, CoursePriced, SubscriptionPaid);

// What the group still lacks: what a cancellation publishes.
const missingOf = (s: { readonly teacherId: string | null; readonly room: string | null; readonly studentIds: ReadonlyArray<string> }) => [
  ...(s.teacherId === null ? ["teacher" as const] : []),
  ...(s.room === null ? ["room" as const] : []),
  ...(s.studentIds.length < MIN_STUDENTS_TO_START ? ["students" as const] : [])
];
```

## 3. The command decides when it is complete

Done already: `noop`. Something missing: `noop("WAITING")`, nothing appended. Complete: emit the aggregate. `byModel()` is the right `idempotentBy`,
because the model shows whether it was done.

<!-- file: examples/course-enrolment-app/src/domain/CourseStart.ts#command -->
```ts
// The completeness condition and the aggregation: once everything is there, one CourseConfirmed; until then, nothing.
// Its boundary is the course's readiness events, so two runs that race append one CourseConfirmed: the second conflicts, re-runs and sees it.
export const ConfirmCourse = defineCommand({
  name: "confirm_course",
  input: Schema.Struct({ courseId: Schema.String }),
  model: (c) => CourseReadiness.of({ id: c.courseId }),
  idempotentBy: byModel(), // the model shows whether it was done; decide answers a repeat
  decide: (s, c) =>
    s.status === "confirmed"
      ? noop("ALREADY_CONFIRMED")
      : s.status === "cancelled"
        ? noop("CANCELLED")
        : s.teacherId === null || s.room === null || s.studentIds.length < MIN_STUDENTS_TO_START
          ? noop("WAITING")
          : emit(CourseConfirmed({ courseId: c.courseId, teacherId: s.teacherId, room: s.room, students: s.studentIds.length }))
});
```

## 4. Every event that could complete it wakes the automation

The handlers only name the group. They do not count or check anything: the command does, on the log, where it is consistent.

<!-- file: examples/course-enrolment-app/src/automations/ConfirmCourseAutomation.ts#automation -->
```ts
// Every event that could complete a course asks ConfirmCourse to look. The handler only names the course (the correlation); whether the
// course is complete is decided by the command, on the log, so the order the events are delivered in does not matter.
export const confirmCourseWhenReady = defineAutomation("confirm-course-when-ready", ConfirmCourse)
  .on(TeacherAssigned, (d) => ({ courseId: d.courseId }))
  .on(RoomBooked, (d) => ({ courseId: d.courseId }))
  .on(StudentSubscribed, (d) => ({ courseId: d.courseId }));
```

Most runs answer `WAITING` and append nothing; that is the price of an Aggregator without a store, one small command per event. Register it with the
automations processor as in [Add an automation](add-an-automation.md#3-register-it). (The course app declares it and tests it; it has no command yet
that assigns teachers or books rooms, so it does not start it.)

## 5. A view of what each group is missing

The partial group as a table: one row per course, and each event fills in its own column, so the rows are the same in any order of delivery. What a course
still lacks is a `WHERE` on that table. The migration is
[`V103__course_readiness_view.sql`](../../../examples/course-enrolment-app/db/migration/V103__course_readiness_view.sql); the rest is as in [Add a view](add-a-view.md).

<!-- file: examples/course-enrolment-app/src/views/CourseReadinessViewProjector.ts#view -->
```ts
// The table, as the migration (db/migration/V103) made it; `checkViewTables` compares the two (test/integration/course-seats-table.test.ts).
export const courseReadinessTable = viewTable("course_readiness_view", {
  key: { course_id: text() },
  columns: { teacher_id: text().nullable(), room: text().nullable(), students: integer().default(0), status: text().default("waiting") }
});

// The row is the partial group: each event fills in its own column, so the rows are the same whatever order the events are delivered in.
// What is still missing is a query (`WHERE teacher_id IS NULL OR room IS NULL ...`); `status` changes only on the aggregate itself.
export const CourseReadinessView = defineView(COURSE_READINESS_VIEW, { tables: [courseReadinessTable] })
  .on(TeacherAssigned, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { teacher_id: d.teacherId } }))
  .on(RoomBooked, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { room: d.room } }))
  .on(StudentSubscribed, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { add: { students: 1 } }))
  .on(SubscriptionReleased, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { add: { students: -1 } }))
  .on(CourseConfirmed, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { status: "confirmed" } }))
  .on(CourseCancelled, (d) => courseReadinessTable.upsert({ course_id: d.courseId }, { set: { status: "cancelled" } }));
```

The view is for reading. Never decide from it: it lags the log, so the decision stays in the command.

## 6. Test it in every order

The claim that order does not matter is cheap to test: five events have 120 orders, and the in-memory scenario runs them all in well under a second.

<!-- file: examples/course-enrolment-app/test/course-start.test.ts#any-order-test -->
```ts
test("in every order the events can arrive in, it waits until the last one, then confirms once", async () => {
  for (const order of orders(parts("math"))) {
    for (let arrived = 1; arrived <= order.length; arrived++) {
      const result = await given(CourseDefined({ courseId: "math", capacity: 30 }), ...order.slice(0, arrived)).when(ConfirmCourse, { courseId: "math" });
      if (arrived < order.length) expect(result.reason).toBe("WAITING");
      else expect(result.events.map((e) => e.type)).toEqual(["CourseConfirmed"]);
    }
  }
});
```

And the automation, with the idempotency check of [Add an automation](add-an-automation.md#4-test-that-it-is-idempotent): ten triggers, two courses,
two confirmations, and handling them all again appends nothing.

<!-- file: examples/course-enrolment-app/test/course-start.test.ts#automation-test -->
```ts
test("each course is confirmed once, however many of its events wake the automation, and a redelivery does nothing", async () => {
  // Ten triggers, two courses: two confirmations. The log is ahead of the deliveries, so the first trigger of a course may already see all of it.
  const report = await assertAutomationIdempotent(confirmCourseWhenReady, [...parts("math"), ...parts("art")]);
  expect(report.effects).toBe(2);
});
```

The same file checks the view in every order of delivery, with `applyInMemory`.

## When the order matters: the Resequencer

EIP's **Resequencer** holds messages back and releases them in sequence. You rarely need one here, because delivery already follows causality: if the
command that appended B read A, every processor sees A before B ([ADR-0033](../../adr/0033-delivery-order-is-causal-order.md)). Events whose commands did not
read each other have no order worth waiting for: which came first is timing, not meaning. When the order is a business rule, put it where it can be enforced:

- **Make it causal (best).** The command that appends B puts A in its model and refuses without it. Then B cannot exist before A, and no processor has to
  wait.
- **Or let the model check the sequence.** The model records what came in which order, and `decide` refuses or ignores a group that broke it. It is explicit,
  and it can be tested in every order as above.

<!-- excerpt -->
```ts
// The first: B is refused without A, so every processor sees A before B.
decide: (s, c) => (!s.teacherAssigned ? fail(new NoTeacherYet({ courseId: c.courseId })) : emit(RoomBooked(c)))
```

## Stop waiting: a deadline

An EIP Aggregator also says when to stop waiting ("confirm with what is there after a week", "cancel if no room is booked by Friday"). Here that is a
**deadline**: the command that starts the wait sets one with its decision, and when it is due the deadlines processor runs the command it names, whose
`decide` reads the same model and decides what to do with a group that is not complete, or answers `noop` for one that completed in time. In the course
app, `DefineCourse` sets `deadline(CancelUnreadyCourse, { courseId }, { at: now + 14 days })`, and:

<!-- file: examples/course-enrolment-app/src/domain/CourseStart.ts#expiry -->
```ts
// The Aggregator's expiry: what the deadline DefineCourse set asks once READINESS_DAYS have passed. A course confirmed in time answers CONFIRMED and
// nothing happens; one still waiting is cancelled, with what it lacked and the students it had, so every one of them gets the slot back in the same
// append (CourseCancelled is tagged with each). Its boundary is the readiness events, the same as ConfirmCourse's: a confirmation and a cancellation that
// race cannot both happen, and a student who subscribes meanwhile makes the cancellation re-run with that student in it.
export const CancelUnreadyCourse = defineCommand({
  name: "cancel_unready_course",
  input: Schema.Struct({ courseId: Schema.String }),
  model: (c) => CourseReadiness.of({ id: c.courseId }),
  idempotentBy: byModel(),
  decide: (s, c) =>
    s.status === "confirmed"
      ? noop("CONFIRMED")
      : s.status === "cancelled"
        ? noop("ALREADY_CANCELLED")
        : emit(CourseCancelled({ courseId: c.courseId, missing: missingOf(s), studentIds: s.studentIds }))
});
```

`CourseCancelled` is the Aggregator's partial result: what was `missing`, and the students it had. It is tagged with the course **and every one of those
students**, so each student's model gives the slot back in the same append, with no command per student; the seats and enrolments views follow it, and
`Subscribe` refuses a cancelled course (`CourseWasCancelled`). Its boundary is `ConfirmCourse`'s, so the two cannot both win:

<!-- file: examples/course-enrolment-app/test/course-start.test.ts#expiry-test -->
```ts
test("at the deadline a course still waiting is cancelled with what it lacked; its students get their slot back and it takes no more", async () => {
  const s = given(CoursePriced({ courseId: "math", price: 100 }), TeacherAssigned({ courseId: "math", teacherId: "t-1" })).at(t0);
  await s.when(DefineCourse, { courseId: "math", capacity: 30 });
  for (const studentId of ["ann", "bob"]) {
    await s.when(Subscribe, { studentId, courseId: "math" });
    await s.when(PaySubscription, { courseId: "math", studentId, paymentId: `p-${studentId}`, amount: 100 });
  }

  // Day 14: the payment deadlines (day 3) answer that the seats are paid; the readiness deadline cancels the course, still without a room.
  const fired = await s.at(daysLater(READINESS_DAYS)).fireDue(CancelUnreadyCourse, ReleaseUnpaidSubscription);
  expect(fired.map((f) => [f.command, f.outcome, f.reason])).toEqual([
    ["release_unpaid_subscription", "noop", "PAID"],
    ["release_unpaid_subscription", "noop", "PAID"],
    ["cancel_unready_course", "appended", null]
  ]);
  const cancelled = fired[2]!.events[0]!;
  expect(cancelled.data).toEqual({ courseId: "math", missing: ["room", "students"], studentIds: ["ann", "bob"] });
  expect(cancelled.tags.map((t) => `${t.key}=${t.value}`)).toEqual(["course_id=math", "student_id=ann", "student_id=bob"]);

  const after = s.at(daysLater(READINESS_DAYS + 1));
  expect((await after.when(Subscribe, { studentId: "cy", courseId: "math" })).error).toBeInstanceOf(CourseWasCancelled);
  expect((await after.when(ConfirmCourse, { courseId: "math" })).reason).toBe("CANCELLED");
  // ann's slot in the three-course limit is free again: three other courses are allowed.
  for (const courseId of ["a", "b", "c"]) {
    await after.when(DefineCourse, { courseId, capacity: 5 });
    expect((await after.when(Subscribe, { studentId: "ann", courseId })).outcome).toBe("created");
  }
});
```

[Set a deadline](set-a-deadline.md) explains deadlines; [ADR-0043](../../adr/0043-a-deadline-is-an-event-in-the-log.md) records the design.

## The rest of EIP, mapped

The patterns from the catalogue that the framework implements, and the two it leaves out on purpose:

| EIP pattern | Here |
|---|---|
| Message Store | The event log |
| Correlation Identifier | Tags, and the correlation and causation ids recorded with each event |
| Publish-Subscribe Channel, Durable Subscriber | One log read by many processors, each with its own cursor |
| Message Filter, Content-Based Router | What a view or automation selects: its event types and tags |
| Splitter | An automation handler that returns several inputs |
| Process Manager | Automations whose commands read the process's state from a model, as the course start does |
| Aggregator's timeout, Scheduler | A deadline: an event in the log, fired by the deadlines processor when it is due ([Set a deadline](set-a-deadline.md)) |
| Idempotent Receiver | `idempotentBy`, and the backstop that stops the same trigger from appending the same request twice ([ADR-0035](../../adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)) |
| Transactional Client | A view's batch commits with its cursor ([ADR-0023](../../adr/0023-view-batch-and-cursor-in-one-transaction.md)); a command reads and appends in one transaction |
| Guaranteed Delivery, Channel Adapter | The outbox and its publishers |
| Messaging Gateway | The HTTP API generated from the commands |
| Competing Consumers | **Not used.** One leader runs each module, so each processor handles its events in order ([ADR-0006](../../adr/0006-leader-election-via-sql-reserve.md)). |
| Dead Letter Channel | **Not used.** An event that cannot be read fails the batch and is retried; it is never set aside ([ADR-0017](../../adr/0017-event-evolution-by-compatibility.md)). |
