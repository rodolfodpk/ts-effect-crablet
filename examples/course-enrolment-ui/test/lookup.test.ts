// Story tests drive `update` (Messages in; Model and Commands out; Commands are resolved inline, nothing is mocked).
// Scene tests drive the real `view` like a user would. Both run under bun:test; no browser, no server.
import { describe, expect, test } from "bun:test";
import * as AsyncData from "foldkit/asyncData";
import { Scene, Story } from "foldkit/test";
import { FetchCourse, Lookup, Message, update, view, type Model } from "../src/main.ts";

expect.extend(Scene.sceneMatchers as never);

const idle: Model = { courseId: "", lookup: AsyncData.Idle() };
const math = { courseId: "math", capacity: 3, subscribers: 1, seatsLeft: 2 };

describe("looking a course up (update)", () => {
  test("submitting asks the server, shows Loading, and a found course is shown", () => {
    Story.story(
      update,
      Story.given<Model>({ ...idle, courseId: "math" }),
      Story.message(Message.SubmittedLookup()),
      Story.model((m: Model) => expect(AsyncData.isLoading(m.lookup)).toBe(true)),
      Story.Command.expectExact(FetchCourse({ courseId: "math" })),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Success({ data: math })))
    );
  });

  test("the id is trimmed before it is sent", () => {
    Story.story(
      update,
      Story.given<Model>({ ...idle, courseId: "  math " }),
      Story.message(Message.SubmittedLookup()),
      Story.Command.expectExact(FetchCourse({ courseId: "math" })),
      Story.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math }))
    );
  });

  test("an empty id asks nothing", () => {
    Story.story(
      update,
      Story.given<Model>(idle),
      Story.message(Message.SubmittedLookup()),
      Story.Command.expectNone(),
      Story.model((m: Model) => expect(AsyncData.isIdle(m.lookup)).toBe(true))
    );
  });

  test("a failed lookup keeps the page usable and says why", () => {
    Story.story(
      update,
      Story.given<Model>({ ...idle, courseId: "ghost" }),
      Story.message(Message.SubmittedLookup()),
      Story.Command.resolve(FetchCourse, Message.FailedFetchCourse({ message: 'There is no course called "ghost".' })),
      Story.model((m: Model) => expect(m.lookup).toEqual(Lookup.Failure({ error: { message: 'There is no course called "ghost".' } })))
    );
  });
});

describe("the page (view)", () => {
  test("type an id, press the button, see the seats", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(idle),
      Scene.type(Scene.role("textbox", { name: "Course id" }), "math"),
      Scene.submit(Scene.role("form")),
      Scene.Command.resolve(FetchCourse, Message.SucceededFetchCourse({ course: math })),
      (Scene.expect(Scene.text("math: 2 of 3 seats left (1 subscribed)")) as any).toExist()
    );
  });

  test("a missing course is announced as an alert", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>({ ...idle, courseId: "ghost" }),
      Scene.submit(Scene.role("form")),
      Scene.Command.resolve(FetchCourse, Message.FailedFetchCourse({ message: 'There is no course called "ghost".' })),
      (Scene.expect(Scene.role("alert")) as any).toContainText("no course called")
    );
  });

  test("negative control: text that is not on the page fails the scene", () => {
    expect(() =>
      Scene.scene(
        { update, view },
        Scene.given<Model>(idle),
        (Scene.expect(Scene.text("99 of 99 seats left")) as any).toExist()
      )
    ).toThrow();
  });
});
