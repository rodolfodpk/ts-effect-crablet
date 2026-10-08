# Step 1 - the rule, in memory

[Tutorial index](README.md) · [Step 2 - Postgres, and the second rule →](02-postgres-and-the-second-rule.md)

There are no streams and no aggregates. You declare three things.

**Events** - a name, a payload, and the *tags* an event can be found by:

<!-- file: examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts#step1-domain -->
```ts
// 1. Events: a name, a payload, and the tags an event can be found by. There are no streams.
const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Int }),
  tags: (d) => ({ course_id: d.courseId })
});
const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

// 2. A model: what the events mean for one course - and, from the same declaration, which events could change that
//    answer (the command's consistency boundary).
const CourseModel = defineModel({ by: "course_id", initial: () => ({ exists: false, capacity: 0, subscribers: 0 }) })
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

class CourseNotFound extends DomainError("CourseNotFound", { fields: { courseId: Schema.String }, kind: "not_found" }) {}
class CourseFull extends DomainError("CourseFull", { fields: { courseId: Schema.String, capacity: Schema.Int }, kind: "conflict" }) {}

// 3. A command: a PURE decision. Nothing here touches a database.
const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull], // the domain errors it can fail with; `decide` may fail with no others
  input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  model: (c) => CourseModel.of({ id: c.courseId }),
  decide: (course, c) =>
    !course.exists
      ? fail(new CourseNotFound({ courseId: c.courseId }))
      : course.subscribers >= course.capacity
        ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
        : emit(StudentSubscribed(c))
});
```

A note on the ids: the tutorial uses readable ids (`ann`, `math-101`) so the examples are easy to follow. In a real system, put **opaque ids** in events and
tags (`student_7f3a...`), and keep names, emails and other personal data out of tags altogether: tags are stored as plain, indexed text and cannot be erased or
redacted. Mark such fields once with `personal(...)` (from `@crablet/commands/Personal`) wherever they appear in an event or a command input, and the framework
redacts them in the command audit and flags them in the API description; building an event whose tag repeats a personal value fails.

Three things to notice:

- `decide` is a **pure function** of the state and the input. It either returns `emit(...)` events or `fail(...)` with a typed error.
- The model's **boundary** - "which events could change this answer" - is derived from the events it handles. You never write a query.
- A command lists the **domain errors** it can fail with in `errors`. `decide` cannot fail with a domain error that is not listed
  (the compiler tells you which one is missing). Step 3 uses that list to document the API.

**A test** - given a history, when a command arrives, then...:

<!-- file: examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts#step1-tests -->
```ts
// 4. Test it: given a history, when a command arrives, then ... (the real command pipeline, against an in-memory store).
describe("step 1: a course holds at most `capacity` students", () => {
  test("a student subscribes to a course with a free seat", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 2 }));
    const result = await scenario.when(Subscribe, { studentId: "ann", courseId: "math" });
    expect(result.outcome).toBe("created");
    expect(result.events.map((e) => e.type)).toEqual(["StudentSubscribed"]);
  });

  test("the last seat goes to whoever asks first; the next student is refused with CourseFull", async () => {
    const scenario = given(CourseDefined({ courseId: "math", capacity: 1 }));
    expect((await scenario.when(Subscribe, { studentId: "ann", courseId: "math" })).outcome).toBe("created");
    const refused = await scenario.when(Subscribe, { studentId: "bob", courseId: "math" });
    expect(refused.error).toBeInstanceOf(CourseFull);
    expect(refused.events).toEqual([]); // nothing was written
  });

  test("an unknown course is refused", async () => {
    const result = await given().when(Subscribe, { studentId: "ann", courseId: "ghost" });
    expect(result.error).toBeInstanceOf(CourseNotFound);
  });
});
```

Run it (from the repository root):

```bash
bun test examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts
```

```
 3 pass
 0 fail
```

`given(...)` runs the **real** command pipeline - input validation, loading the model, `decide`, the conditional append - against an
in-memory store that behaves like the Postgres one (a conformance suite checks that). What it cannot show is concurrency: nothing
interleaves in memory. That is [step 2](02-postgres-and-the-second-rule.md).

---

**You now have** a course rule decided from events, with its boundary derived from the model, and tested in memory with Given/When/Then. No database was involved.

[Tutorial index](README.md) · [Step 2 - Postgres, and the second rule →](02-postgres-and-the-second-rule.md)
