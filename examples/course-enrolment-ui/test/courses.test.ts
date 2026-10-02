// The course list: loaded at startup, filtered by id prefix, paged with "More", reloaded after a write, and a click opens a course.
import { describe, expect, test } from "bun:test";
import * as AsyncData from "foldkit/asyncData";
import { Scene, Story } from "foldkit/test";
import { CourseList, FetchCourse, FetchCourses, Message, init, update, view, type Model } from "../src/main.ts";

expect.extend(Scene.sceneMatchers as never);

const course = (courseId: string, seatsLeft = 2) => ({ courseId, capacity: 3, subscribers: 3 - seatsLeft, seatsLeft });
const loaded = (ids: ReadonlyArray<string>, next: string | null): Model => ({
  ...init().model,
  courses: { filter: "", applied: "", result: CourseList.Success({ data: { items: ids.map((id) => course(id)), next } }) }
});

describe("the course list: update", () => {
  test("the page starts by loading the first page", () => {
    const start = init();
    // a Command holds an Effect, so compare what identifies it: its name and arguments
    expect(start.commands?.map((c) => ({ name: c.name, args: c.args }))).toEqual([{ name: "FetchCourses", args: { q: "", after: null, append: false } }]);
    expect(AsyncData.isLoading(start.model.courses.result)).toBe(true);
  });

  test("a loaded page is shown, with its cursor", () => {
    Story.story(
      update,
      Story.given<Model>(init().model),
      Story.message(Message.SucceededFetchCourses({ items: [course("algebra"), course("biology")], next: "biology", append: false })),
      Story.model((m: Model) => expect(m.courses.result).toEqual(CourseList.Success({ data: { items: [course("algebra"), course("biology")], next: "biology" } })))
    );
  });

  test("More asks for the page after the cursor and appends it", () => {
    Story.story(
      update,
      Story.given<Model>(loaded(["algebra", "biology"], "biology")),
      Story.message(Message.ClickedMoreCourses()),
      Story.Command.expectExact(FetchCourses({ q: "", after: "biology", append: true })),
      Story.Command.resolve(FetchCourses, Message.SucceededFetchCourses({ items: [course("calculus")], next: null, append: true })),
      Story.model((m: Model) =>
        expect(m.courses.result).toEqual(CourseList.Success({ data: { items: [course("algebra"), course("biology"), course("calculus")], next: null } }))
      )
    );
  });

  test("More on the last page asks nothing", () => {
    Story.story(update, Story.given<Model>(loaded(["algebra"], null)), Story.message(Message.ClickedMoreCourses()), Story.Command.expectNone());
  });

  test("filtering starts again from the first page, with the trimmed text, and keeps it for More", () => {
    Story.story(
      update,
      Story.given<Model>(loaded(["algebra", "biology"], "biology")),
      Story.message(Message.ChangedCourseFilter({ value: "  phys " })),
      Story.message(Message.SubmittedCourseFilter()),
      Story.Command.expectExact(FetchCourses({ q: "phys", after: null, append: false })),
      Story.Command.resolve(FetchCourses, Message.SucceededFetchCourses({ items: [course("physics-101")], next: "physics-101", append: false })),
      Story.model((m: Model) => expect(m.courses.applied).toBe("phys")),
      Story.message(Message.ClickedMoreCourses()),
      Story.Command.expectExact(FetchCourses({ q: "phys", after: "physics-101", append: true })),
      Story.Command.resolve(FetchCourses, Message.SucceededFetchCourses({ items: [], next: null, append: true }))
    );
  });

  test("clicking a course opens it in the lookup", () => {
    Story.story(
      update,
      Story.given<Model>(loaded(["algebra"], null)),
      Story.message(Message.ClickedCourse({ courseId: "algebra" })),
      Story.model((m: Model) => expect(m.lookupCourseId).toBe("algebra")),
      Story.Command.expectExact(FetchCourse({ courseId: "algebra" })),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: course("algebra") }))
    );
  });

  test("a failed load is a problem the page can show, and a later success replaces it", () => {
    Story.story(
      update,
      Story.given<Model>(init().model),
      Story.message(Message.FailedFetchCourses({ problem: { _tag: "Unreachable" } })),
      Story.model((m: Model) => expect(AsyncData.isFailure(m.courses.result)).toBe(true)),
      Story.message(Message.SucceededFetchCourses({ items: [course("algebra")], next: null, append: false })),
      Story.model((m: Model) => expect(AsyncData.isSuccess(m.courses.result)).toBe(true))
    );
  });
});

describe("the course list: the page", () => {
  test("shows a button per course with its seats, and More only while there is another page", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(loaded(["algebra", "biology"], "biology")),
      (Scene.expect(Scene.text("algebra: 2 of 3 seats left")) as any).toExist(),
      (Scene.expect(Scene.text("biology: 2 of 3 seats left")) as any).toExist(),
      (Scene.expect(Scene.role("button", { name: "More" })) as any).toExist()
    );
    Scene.scene(
      { update, view },
      Scene.given<Model>(loaded(["algebra"], null)),
      (Scene.expect(Scene.role("button", { name: "More" })) as any).not.toExist()
    );
  });

  test("an empty list says so", () => {
    Scene.scene({ update, view }, Scene.given<Model>(loaded([], null)), (Scene.expect(Scene.text("No courses.")) as any).toExist());
  });

  test("clicking a course shows it in the lookup", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(loaded(["algebra"], null)),
      Scene.click(Scene.role("button", { name: "algebra: 2 of 3 seats left" })),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: course("algebra") })),
      (Scene.expect(Scene.text("algebra: 2 of 3 seats left (1 subscribed)")) as any).toExist()
    );
  });

  test("typing a filter and submitting asks for the filtered list", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(loaded(["algebra"], null)),
      Scene.type(Scene.role("textbox", { name: "Filter courses" }), "al"),
      Scene.submit(Scene.role("form", { name: "Course filter form" })),
      Scene.Command.expectExact(FetchCourses({ q: "al", after: null, append: false })),
      Scene.Command.resolve(FetchCourses, Message.SucceededFetchCourses({ items: [course("algebra")], next: null, append: false }))
    );
  });
});
