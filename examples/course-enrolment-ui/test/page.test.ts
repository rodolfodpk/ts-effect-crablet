// Story tests drive `update` (Messages in; Model and Commands out; Commands are resolved inline, nothing is mocked).
// Scene tests drive the real `view` like a user would. Both run under bun:test; no browser, no server.
import { describe, expect, test } from "bun:test";
import * as AsyncData from "foldkit/asyncData";
import * as FieldValidation from "foldkit/fieldValidation";
import { Scene, Story } from "foldkit/test";
import {
  DefineCourse,
  DefineResult,
  FetchCourse,
  FetchCourses,
  Lookup,
  Message,
  SubscribeResult,
  SubscribeStudent,
  describeProblem,
  init,
  viewNote,
  update,
  view,
  type Model
} from "../src/main.ts";

expect.extend(Scene.sceneMatchers as never);

const start: Model = init().model;
const math = { courseId: "math", capacity: 3, subscribers: 1, seatsLeft: 2 };
const typed = (value: string) => FieldValidation.Valid({ value });
const reloadList = { q: "", after: null, append: false } as const;
const noCourses = Message.SucceededFetchCourses({ items: [], next: null, append: false });
const created = { status: "CREATED", reason: null } as const;
const caughtUp = { ...created, view: { name: "course-seats-view", caughtUp: true } } as const;

describe("looking a course up", () => {
  test("submitting asks the server, shows Working, and a found course is shown", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookupCourseId: "math" }),
      Story.message(Message.SubmittedLookup()),
      Story.model((m: Model) => expect(AsyncData.isLoading(m.lookup)).toBe(true)),
      Story.Command.expectExact(FetchCourse({ courseId: "math" })),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Success({ data: math })))
    );
  });

  test("an empty id asks nothing", () => {
    Story.story(update, Story.given<Model>(start), Story.message(Message.SubmittedLookup()), Story.Command.expectNone());
  });

  test("a missing course is a typed problem, not a crash", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookupCourseId: "ghost" }),
      Story.message(Message.SubmittedLookup()),
      Story.Command.resolve(FetchCourse, Message.FailedFetchCourse({ problem: { _tag: "CourseNotFound", courseId: "ghost" } })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Failure({ error: { _tag: "CourseNotFound", courseId: "ghost" } })))
    );
  });
});

describe("defining a course", () => {
  const filled: Model = { ...start, define: { ...start.define, courseId: typed("math"), capacity: typed("3") } };

  test("typing validates the field as you go", () => {
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.ChangedDefineCapacity({ value: "0" })),
      Story.model((m: Model) => {
        expect(m.define.capacity._tag).toBe("Invalid");
        expect(m.define.capacity._tag === "Invalid" && m.define.capacity.errors[0]).toBe("Capacity must be a whole number, 1 or more.");
      }),
      Story.message(Message.ChangedDefineCapacity({ value: "3" })),
      Story.model((m: Model) => expect(m.define.capacity._tag).toBe("Valid"))
    );
  });

  test("an incomplete form asks nothing and marks the fields", () => {
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.SubmittedDefineCourse()),
      Story.Command.expectNone(),
      Story.model((m: Model) => {
        expect(m.define.courseId._tag).toBe("Invalid");
        expect(m.define.capacity._tag).toBe("Invalid");
        expect(AsyncData.isIdle(m.define.result)).toBe(true);
      })
    );
  });

  test("a valid form sends the command with the capacity as a number, and success is shown", () => {
    Story.story(
      update,
      Story.given<Model>(filled),
      Story.message(Message.SubmittedDefineCourse()),
      Story.Command.expectExact(DefineCourse({ courseId: "math", capacity: 3, waitForView: true })),
      Story.Command.resolve(DefineCourse, Message.SucceededDefineCourse({ courseId: "math", capacity: 3, outcome: caughtUp })),
      Story.model((m: Model) => expect(m.define.result).toEqual(DefineResult.Success({ data: { courseId: "math", capacity: 3, outcome: caughtUp } }))),
      // read your own write: the page looks the new course up
      Story.Command.expectExact(FetchCourse({ courseId: "math" }), FetchCourses(reloadList)),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: { ...math, subscribers: 0, seatsLeft: 3 } })),
      Story.Command.resolve(FetchCourses, noCourses)
    );
  });

  test("defining the same course twice is the framework's conflict, shown with its detail", () => {
    const problem = { _tag: "Rejected", title: "Conflict", detail: "duplicate operation detected" } as const;
    Story.story(
      update,
      Story.given<Model>(filled),
      Story.message(Message.SubmittedDefineCourse()),
      Story.Command.resolve(DefineCourse, Message.FailedDefineCourse({ problem })),
      Story.model((m: Model) => expect(m.define.result).toEqual(DefineResult.Failure({ error: problem })))
    );
    expect(describeProblem(problem)).toBe("Conflict: duplicate operation detected");
  });
});

describe("subscribing a student", () => {
  const filled: Model = { ...start, subscribe: { ...start.subscribe, studentId: typed("ann"), courseId: typed("math") } };

  test("a valid form sends the command; a new subscription and an idempotent repeat read differently", () => {
    Story.story(
      update,
      Story.given<Model>(filled),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math", waitForView: true })),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: caughtUp })),
      Story.model((m: Model) =>
        expect(m.subscribe.result).toEqual(SubscribeResult.Success({ data: { studentId: "ann", courseId: "math", outcome: caughtUp } }))
      ),
      Story.Command.expectExact(FetchCourse({ courseId: "math" }), FetchCourses(reloadList)),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      Story.Command.resolve(FetchCourses, noCourses)
    );
  });

  test.each([
    [{ _tag: "CourseNotFound", courseId: "ghost" } as const, 'There is no course called "ghost".'],
    [{ _tag: "CourseFull", courseId: "math", capacity: 1 } as const, 'Course "math" is full (1 seats, all taken).'],
    [{ _tag: "StudentAtLimit", studentId: "ann", limit: 3 } as const, "ann is already in 3 courses, the most one student can take."],
    [{ _tag: "Mismatch", detail: 'Expected a value greater than or equal to 1\n  at ["capacity"]' } as const, 'That does not match the API definition: Expected a value greater than or equal to 1   at ["capacity"]'],
    [{ _tag: "Unreachable" } as const, "The server could not be reached."]
  ])("a refusal (%o) is shown as: %s", (problem, text) => {
    Story.story(
      update,
      Story.given<Model>(filled),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.FailedSubscribe({ problem })),
      Story.model((m: Model) => expect(m.subscribe.result).toEqual(SubscribeResult.Failure({ error: problem })))
    );
    expect(describeProblem(problem)).toBe(text);
  });
});

describe("reading your own writes", () => {
  const filledSubscribe: Model = { ...start, subscribe: { ...start.subscribe, studentId: typed("ann"), courseId: typed("math") } };

  test("the toggle is on at the start and flips", () => {
    expect(start.waitForView).toBe(true);
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.ToggledWaitForView()),
      Story.model((m: Model) => expect(m.waitForView).toBe(false)),
      Story.message(Message.ToggledWaitForView()),
      Story.model((m: Model) => expect(m.waitForView).toBe(true))
    );
  });

  test("with the toggle off, the write does not ask to wait, and the read back still happens (and may be stale)", () => {
    const stale = { ...math, subscribers: 0, seatsLeft: 3 }; // the view has not applied the subscription yet
    Story.story(
      update,
      Story.given<Model>({ ...filledSubscribe, waitForView: false }),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math", waitForView: false })),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.model((m: Model) => expect(m.lookupCourseId).toBe("math")),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: stale })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Success({ data: stale })))
    );
  });

  test("a 'no such course' for the course just written means the seat map lags, not that it does not exist", () => {
    const missing = { _tag: "CourseNotFound", courseId: "math" } as const;
    Story.story(
      update,
      Story.given<Model>({ ...filledSubscribe, waitForView: false }),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.FailedFetchCourse({ problem: missing })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Failure({ error: { _tag: "NotInSeatMapYet", courseId: "math" } }))),
      // the user looks something up themselves: now a missing course really is missing
      Story.message(Message.ChangedLookupCourseId({ value: "ghost" })),
      Story.message(Message.SubmittedLookup()),
      Story.Command.resolve(FetchCourse, Message.FailedFetchCourse({ problem: { _tag: "CourseNotFound", courseId: "ghost" } })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Failure({ error: { _tag: "CourseNotFound", courseId: "ghost" } })))
    );
    expect(describeProblem({ _tag: "NotInSeatMapYet", courseId: "math" })).toContain("has not caught up");
  });

  test("what the page says about the seat map, for every answer the server can give", () => {
    expect(viewNote(created)).toContain("Not waiting");
    expect(viewNote(caughtUp)).toBe("The seat map had caught up when this answered.");
    const miss = (reason: "timeout" | "view_failed" | "unavailable" | "nothing_appended") =>
      viewNote({ ...created, view: { name: "course-seats-view", caughtUp: false, reason } });
    expect(miss("timeout")).toContain("had not caught up in time");
    expect(miss("view_failed")).toContain("not updating");
    expect(miss("unavailable")).toContain("Could not tell");
    expect(miss("nothing_appended")).toBe("");
  });

  test("a write that waited but timed out is reported, not hidden", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.inside(
        Scene.role("form", { name: "Subscribe form" }),
        Scene.type(Scene.role("textbox", { name: "Student id" }), "ann"),
        Scene.type(Scene.role("textbox", { name: "Course" }), "math"),
        Scene.submit(Scene.role("form", { name: "Subscribe form" }))
      ),
      Scene.Command.resolve(
        SubscribeStudent,
        Message.SucceededSubscribe({
          studentId: "ann",
          courseId: "math",
          outcome: { ...created, view: { name: "course-seats-view", caughtUp: false, reason: "timeout" } }
        })
      ),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: { ...math, subscribers: 0, seatsLeft: 3 } })),
      Scene.Command.resolve(FetchCourses, noCourses),
      (Scene.expect(Scene.text("ann is now subscribed to math. The seat map had not caught up in time, so the numbers below may be stale.")) as any).toExist()
    );
  });

  test("the checkbox turns the waiting off", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.click(Scene.role("checkbox", { name: "Wait for the seat map" })),
      Scene.inside(
        Scene.role("form", { name: "Subscribe form" }),
        Scene.type(Scene.role("textbox", { name: "Student id" }), "ann"),
        Scene.type(Scene.role("textbox", { name: "Course" }), "math"),
        Scene.submit(Scene.role("form", { name: "Subscribe form" }))
      ),
      Scene.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math", waitForView: false })),
      Scene.Command.resolve(SubscribeStudent, Message.FailedSubscribe({ problem: { _tag: "Unreachable" } }))
    );
  });
});

describe("the page", () => {
  test("subscribing: type both ids, submit, and the refusal is announced", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.inside(
        Scene.role("form", { name: "Subscribe form" }),
        Scene.type(Scene.role("textbox", { name: "Student id" }), "ann"),
        Scene.type(Scene.role("textbox", { name: "Course" }), "math"),
        Scene.submit(Scene.role("form", { name: "Subscribe form" }))
      ),
      Scene.Command.resolve(SubscribeStudent, Message.FailedSubscribe({ problem: { _tag: "CourseFull", courseId: "math", capacity: 1 } })),
      (Scene.expect(Scene.role("alert")) as any).toContainText('Course "math" is full')
    );
  });

  test("defining with an empty form shows what is missing and sends nothing", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.submit(Scene.role("form", { name: "Define a course form" })),
      (Scene.expect(Scene.text("Required.")) as any).toExist()
    );
  });

  test("a successful definition is confirmed", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.inside(
        Scene.role("form", { name: "Define a course form" }),
        Scene.type(Scene.role("textbox", { name: "Course id" }), "math"),
        Scene.type(Scene.role("textbox", { name: "Capacity" }), "3"),
        Scene.submit(Scene.role("form", { name: "Define a course form" }))
      ),
      Scene.Command.resolve(DefineCourse, Message.SucceededDefineCourse({ courseId: "math", capacity: 3, outcome: caughtUp })),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: { ...math, subscribers: 0, seatsLeft: 3 } })),
      Scene.Command.resolve(FetchCourses, noCourses),
      (Scene.expect(Scene.text("Defined course math with 3 seats. The seat map had caught up when this answered.")) as any).toExist(),
      (Scene.expect(Scene.text("math: 3 of 3 seats left (0 subscribed)")) as any).toExist()
    );
  });

  test("negative control: text that is not on the page fails the scene", () => {
    expect(() =>
      Scene.scene({ update, view }, Scene.given<Model>(start), (Scene.expect(Scene.text("99 of 99 seats left")) as any).toExist())
    ).toThrow();
  });
});
