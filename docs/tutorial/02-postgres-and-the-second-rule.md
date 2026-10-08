# Step 2 - Postgres, and the second rule

[← Step 1 - the rule, in memory](01-the-rule-in-memory.md) · [Tutorial index](README.md) · [Step 3 - an HTTP API →](03-an-http-api.md)

Everything from here lives in the example package:

```bash
cd examples/course-enrolment-app
docker compose up -d      # a Postgres 18 on localhost:5432 (database courses_db, user and password postgres)
node src/migrate.ts       # creates the framework's tables and this app's own. Run it ONCE per fresh database
```

```
Migrations applied.
```

The domain in `src/domain/Enrolment.ts` is the **final** one: step 1's rule plus the student limit. This is the DCB moment - compare
with step 1. The events and models now look at each other from two sides:

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#events -->
```ts
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  tags: (d) => ({ course_id: d.courseId })
});

// One fact, tagged with BOTH the student and the course it concerns.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});
```

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#models -->
```ts
// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));
```

A command has two parts. Its **contract** - its name, its input Schema and the domain errors it can fail with - is the public part. It lives in
`src/domain/enrolment.contract.ts` (the error classes too), and that file imports nothing that decides anything:

<!-- file: examples/course-enrolment-app/src/domain/enrolment.contract.ts#contracts -->
```ts
export const DefineCourseContract = commandContract({
  name: "define_course",
  input: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })
});

export const SubscribeContract = commandContract({
  name: "subscribe",
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  errors: [CourseNotFound, CourseFull, StudentAtLimit]
});
```

Its **behavior** - the model and `decide` - is the private part. You add it by spreading the contract into `defineCommand`, the same function as in step 1; the contract
is only where the name, the input and the errors now come from. From step 3 the HTTP API is declared from contracts alone, and so is the page in step 5, so a
browser can import them without receiving the rules (a test fails if the contract module ever reaches a server-only module). The command decides on **both** the course and the student at once:

<!-- file: examples/course-enrolment-app/src/domain/Enrolment.ts#subscribe -->
```ts
export const Subscribe = defineCommand({
  ...SubscribeContract,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  decide: ({ course, student }, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : student.courses.includes(c.courseId)
        ? noop("ALREADY_SUBSCRIBED")
        : course.subscribers >= course.capacity
          ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
          : student.courses.length >= MAX_COURSES_PER_STUDENT
            ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
            : emit(StudentSubscribed(c))
});
```

Adding the second rule was: a second model, `all({ course, student })` instead of one model, and one more branch in `decide`. Nothing was
redesigned. The consistency boundary of `subscribe` is now *the course's events plus the student's events*: a subscription by anyone to
this course, or by this student to any course, invalidates a decision made on stale state, and the command is re-run with fresh state.

Now run the **same** commands against the real database:

```bash
node scripts/step2-postgres.ts
```

```
two students race for the last seat: subscribed, CourseFull
one student subscribes to four courses: subscribed, subscribed, subscribed, StudentAtLimit
```

The first line is two students asking for the last seat at the same moment: exactly one is subscribed, the other is refused with
`CourseFull` - after the framework noticed that its decision was made on stale state and re-ran it. (The order of the two words may differ.)
The second is a student's fourth course being refused. The code behind the race is short:

<!-- file: examples/course-enrolment-app/src/step2Demo.ts#step2-race -->
```ts
// Rule 1: a course holds at most `capacity` students. Two students race for the LAST seat.
yield* executor.run(DefineCourse, { courseId: `physics-${id}`, capacity: 1 });
const lastSeat = yield* Effect.all([subscribe(`ann-${id}`, `physics-${id}`), subscribe(`bob-${id}`, `physics-${id}`)], { concurrency: 2 });
log(`two students race for the last seat: ${lastSeat.join(", ")}`);
```

This demo races naturally, so the guarantee it shows is "exactly one winner". The framework's own tests *force* the overlap (every racer
loads its state before any appends) for this same domain: see
[`enrolment-guide-postgres.test.ts`](../../packages/commands/test/integration/enrolment-guide-postgres.test.ts), and the
[DCB guide](../dcb-guide.md) for the theory.

---

**You now have** the same commands running on Postgres, a second rule (a student takes at most 3 courses) decided together with the first, and two races resolved by the append condition.

[← Step 1 - the rule, in memory](01-the-rule-in-memory.md) · [Tutorial index](README.md) · [Step 3 - an HTTP API →](03-an-http-api.md)
