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
  readBackNote,
  update,
  view,
  type Model
} from "../src/main.ts";

expect.extend(Scene.sceneMatchers as never);

const start: Model = init().model;
const math = { courseId: "math", capacity: 3, subscribers: 1, seatsLeft: 2 };
const typed = (value: string) => FieldValidation.Valid({ value });
// What a write answers with: the marker of what it wrote (null when it wrote nothing: an idempotent repeat).
const marker = "7421:98213";
const created = { status: "CREATED", reason: null, marker } as const;
const repeat = { status: "IDEMPOTENT", reason: "ALREADY_SUBSCRIBED", marker: null } as const;
// The read-back after a write: with the write's marker, or with nothing.
const reloadList = { q: "", after: null, append: false, consistentWith: null } as const;
const reloadListMarked = { ...reloadList, consistentWith: marker } as const;
const reloadListLatest = { ...reloadList, consistentWith: "latest" } as const;
const reloadListEventual = { ...reloadList, eventual: true } as const;
const noCourses = Message.SucceededFetchCourses({ items: [], next: null, append: false });

describe("looking a course up", () => {
  test("submitting asks the server, shows Working, and a found course is shown", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookupCourseId: "math" }),
      Story.message(Message.SubmittedLookup()),
      Story.model((m: Model) => expect(AsyncData.isLoading(m.lookup)).toBe(true)),
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: null })),
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
      Story.Command.expectExact(DefineCourse({ courseId: "math", capacity: 3 })),
      Story.Command.resolve(DefineCourse, Message.SucceededDefineCourse({ courseId: "math", capacity: 3, outcome: created })),
      Story.model((m: Model) =>
        expect(m.define.result).toEqual(DefineResult.Success({ data: { courseId: "math", capacity: 3, outcome: created, readBack: "with_marker" } }))
      ),
      // read your own write: the page looks the new course up, and reads the list, both with the write's marker
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: marker }), FetchCourses(reloadListMarked)),
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
      Story.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math" })),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.model((m: Model) =>
        expect(m.subscribe.result).toEqual(SubscribeResult.Success({ data: { studentId: "ann", courseId: "math", outcome: created, readBack: "with_marker" } }))
      ),
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: marker }), FetchCourses(reloadListMarked)),
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

  test("reading back with the marker is on at the start and the toggle flips it", () => {
    expect(start.readWithMarker).toBe(true);
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.ToggledReadWithMarker()),
      Story.model((m: Model) => expect(m.readWithMarker).toBe(false)),
      Story.message(Message.ToggledReadWithMarker()),
      Story.model((m: Model) => expect(m.readWithMarker).toBe(true))
    );
  });

  test("a write never asks the server to wait: the same command goes out with the toggle on or off", () => {
    for (const readWithMarker of [true, false]) {
      Story.story(
        update,
        Story.given<Model>({ ...filledSubscribe, readWithMarker }),
        Story.message(Message.SubmittedSubscribe()),
        Story.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math" })),
        Story.Command.resolve(SubscribeStudent, Message.FailedSubscribe({ problem: { _tag: "Unreachable" } }))
      );
    }
  });

  test("with the toggle on, the course and the list are read back with the write's marker", () => {
    Story.story(
      update,
      Story.given<Model>(filledSubscribe),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: marker }), FetchCourses(reloadListMarked)),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Success({ data: math })))
    );
  });

  test("with the toggle off, the read back asks not to wait (and may be stale)", () => {
    const stale = { ...math, subscribers: 0, seatsLeft: 3 }; // the view has not applied the subscription yet
    Story.story(
      update,
      Story.given<Model>({ ...filledSubscribe, readWithMarker: false }),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.model((m: Model) => {
        expect(m.lookupCourseId).toBe("math");
        expect(m.subscribe.result).toEqual(SubscribeResult.Success({ data: { studentId: "ann", courseId: "math", outcome: created, readBack: "eventual" } }));
      }),
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: null, eventual: true }), FetchCourses(reloadListEventual)),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: stale })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Success({ data: stale })))
    );
  });

  test("a repeat that wrote nothing has no marker: the read back asks for `latest`, and the page says why", () => {
    Story.story(
      update,
      Story.given<Model>(filledSubscribe),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: repeat })),
      Story.model((m: Model) =>
        expect(m.subscribe.result).toEqual(SubscribeResult.Success({ data: { studentId: "ann", courseId: "math", outcome: repeat, readBack: "latest" } }))
      ),
      Story.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: "latest" }), FetchCourses(reloadListLatest)),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      Story.Command.resolve(FetchCourses, noCourses)
    );
  });

  test("a seat-map ping reads again without a marker: it is a hint that the view moved, not a write of this page's", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, lookup: Lookup.Success({ data: math }) }),
      Story.message(Message.ReceivedSeatMapPing()),
      Story.Command.expectExact(FetchCourses(reloadList), FetchCourse({ courseId: "math", consistentWith: null })),
      Story.Command.resolve(FetchCourses, noCourses),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math }))
    );
  });

  test("a 'no such course' for the course just written means the seat map lags, not that it does not exist", () => {
    const missing = { _tag: "CourseNotFound", courseId: "math" } as const;
    Story.story(
      update,
      Story.given<Model>({ ...filledSubscribe, readWithMarker: false }),
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

  test("what the page says about the read back, for each way it can be made", () => {
    expect(readBackNote("with_marker")).toBe("Read back with this write's marker, so the numbers below include it.");
    expect(readBackNote("eventual")).toContain("may be stale");
    expect(readBackNote("latest")).toContain("waited for everything committed so far");
  });

  test("a read the server refused because the seat map could not catch up is reported, not hidden", () => {
    Story.story(
      update,
      Story.given<Model>(filledSubscribe),
      Story.message(Message.SubmittedSubscribe()),
      Story.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Story.Command.resolve(FetchCourses, Message.FailedFetchCourses({ problem: { _tag: "SeatMapBehind", failed: false } })),
      Story.Command.resolve(FetchCourse, Message.FailedFetchCourse({ problem: { _tag: "SeatMapBehind", failed: false } })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Failure({ error: { _tag: "SeatMapBehind", failed: false } })))
    );
    expect(describeProblem({ _tag: "SeatMapBehind", failed: false })).toBe("The seat map has not caught up with your write yet. Try again in a moment.");
    expect(describeProblem({ _tag: "SeatMapBehind", failed: true })).toContain("not updating");
  });

  test("the page tells the user which read it made, and a refused read-back is announced", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.inside(
        Scene.role("form", { name: "Subscribe form" }),
        Scene.type(Scene.role("textbox", { name: "Student id" }), "ann"),
        Scene.type(Scene.role("textbox", { name: "Course" }), "math"),
        Scene.submit(Scene.role("form", { name: "Subscribe form" }))
      ),
      Scene.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Scene.Command.resolve(FetchCourse, Message.FailedFetchCourse({ problem: { _tag: "SeatMapBehind", failed: false } })),
      Scene.Command.resolve(FetchCourses, noCourses),
      (Scene.expect(Scene.text("ann is now subscribed to math. Read back with this write's marker, so the numbers below include it.")) as any).toExist(),
      (Scene.expect(Scene.text("The seat map has not caught up with your write yet. Try again in a moment.")) as any).toExist()
    );
  });

  test("the checkbox turns the marker off: the write is the same, the read back asks not to wait", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.click(Scene.role("checkbox", { name: "Read back with the write's marker" })),
      Scene.inside(
        Scene.role("form", { name: "Subscribe form" }),
        Scene.type(Scene.role("textbox", { name: "Student id" }), "ann"),
        Scene.type(Scene.role("textbox", { name: "Course" }), "math"),
        Scene.submit(Scene.role("form", { name: "Subscribe form" }))
      ),
      Scene.Command.expectExact(SubscribeStudent({ studentId: "ann", courseId: "math" })),
      Scene.Command.resolve(SubscribeStudent, Message.SucceededSubscribe({ studentId: "ann", courseId: "math", outcome: created })),
      Scene.Command.expectExact(FetchCourse({ courseId: "math", consistentWith: null, eventual: true }), FetchCourses(reloadListEventual)),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: { ...math, subscribers: 0, seatsLeft: 3 } })),
      Scene.Command.resolve(FetchCourses, noCourses),
      (Scene.expect(Scene.text("ann is now subscribed to math. Read back without waiting for the seat map, so the numbers below may be stale.")) as any).toExist()
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
      Scene.Command.resolve(DefineCourse, Message.SucceededDefineCourse({ courseId: "math", capacity: 3, outcome: created })),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: { ...math, subscribers: 0, seatsLeft: 3 } })),
      Scene.Command.resolve(FetchCourses, noCourses),
      (Scene.expect(Scene.text("Defined course math with 3 seats. Read back with this write's marker, so the numbers below include it.")) as any).toExist(),
      (Scene.expect(Scene.text("math: 3 of 3 seats left (0 subscribed)")) as any).toExist()
    );
  });

  test("negative control: text that is not on the page fails the scene", () => {
    expect(() =>
      Scene.scene({ update, view }, Scene.given<Model>(start), (Scene.expect(Scene.text("99 of 99 seats left")) as any).toExist())
    ).toThrow();
  });
});
