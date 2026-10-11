// Story tests drive `update` (Messages in; Model and Commands out; Commands are resolved inline, nothing is mocked).
// Scene tests drive the real `view` like a user would. Both run under bun:test; no browser, no server.
import { describe, expect, test } from "bun:test";
import * as AsyncData from "foldkit/asyncData";
import { Scene, Story } from "foldkit/test";
import {
  ActOnProcessor,
  FetchProcessors,
  Message,
  Processors,
  actionsFor,
  describeAction,
  describeProblem,
  formatAge,
  formatWaiting,
  init,
  update,
  view,
  type Model
} from "../src/main.ts";
import type { ProcessorInfo } from "../src/api.ts";

expect.extend(Scene.sceneMatchers as never);

const start: Model = init().model;
const info = (over: Partial<ProcessorInfo> = {}): ProcessorInfo => ({
  kind: "views", id: "wallet-balance-view", description: "The balance of each wallet", status: "ACTIVE", errorCount: 0, lastError: null,
  cursorPosition: "120", pendingEvents: 0, pendingCapped: false, oldestPendingSeconds: null, backedOff: false, ...over
});
const connected = (processors: ReadonlyArray<ProcessorInfo>, over: Partial<Model> = {}): Model => ({ ...start, token: "t0ken", processors: Processors.Success({ data: processors }), ...over });

describe("connecting", () => {
  test("the page starts disconnected and asks for nothing", () => {
    expect(start.token).toBeNull();
    expect(AsyncData.isIdle(start.processors)).toBe(true);
    expect(init().commands ?? []).toEqual([]);
  });

  test("submitting a token lists the processors with it, and the typed token is not kept in the input", () => {
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.ChangedToken({ value: "  s3cret " })),
      Story.message(Message.SubmittedToken()),
      Story.model((m: Model) => {
        expect(m.token).toBe("s3cret");
        expect(m.tokenInput).toBe("");
        expect(AsyncData.isLoading(m.processors)).toBe(true);
      }),
      Story.Command.expectExact(FetchProcessors({ token: "s3cret" })),
      Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [info()] })),
      Story.model((m: Model) => expect(m.processors).toEqual(Processors.Success({ data: [info()] })))
    );
  });

  test("a blank token asks nothing", () => {
    Story.story(update, Story.given<Model>({ ...start, tokenInput: "   " }), Story.message(Message.SubmittedToken()), Story.Command.expectNone());
  });

  test("a refused token ends the session: the page asks for another and does not retry with the same one", () => {
    Story.story(
      update,
      Story.given<Model>({ ...start, tokenInput: "nope" }),
      Story.message(Message.SubmittedToken()),
      Story.Command.resolve(FetchProcessors, Message.FailedList({ problem: { _tag: "Unauthorized" } })),
      Story.model((m: Model) => {
        expect(m.token).toBeNull();
        expect(AsyncData.isIdle(m.processors)).toBe(true);
      }),
      Story.Command.expectNone()
    );
  });

  test("another failure keeps the session and shows the problem", () => {
    Story.story(
      update,
      Story.given<Model>(connected([])),
      Story.message(Message.FailedList({ problem: { _tag: "Unreachable" } })),
      Story.model((m: Model) => {
        expect(m.token).toBe("t0ken");
        expect(AsyncData.isFailure(m.processors)).toBe(true);
      })
    );
  });
});

describe("refreshing", () => {
  test("the button, and the timer, read the list again with the token; a tick does nothing while an action is in flight", () => {
    for (const message of [Message.ClickedRefresh(), Message.Ticked()]) {
      Story.story(
        update,
        Story.given<Model>(connected([info()])),
        Story.message(message),
        Story.Command.expectExact(FetchProcessors({ token: "t0ken" })),
        Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [] }))
      );
    }
    Story.story(
      update,
      Story.given<Model>(connected([info()], { acting: { kind: "views", id: "x", action: "pause" } })),
      Story.message(Message.Ticked()),
      Story.Command.expectNone()
    );
  });

  test("while disconnected there is nothing to refresh", () => {
    Story.story(update, Story.given<Model>(start), Story.message(Message.Ticked()), Story.Command.expectNone());
    Story.story(update, Story.given<Model>(start), Story.message(Message.ClickedRefresh()), Story.Command.expectNone());
  });

  test("a refresh keeps the list on screen until the new one arrives", () => {
    Story.story(
      update,
      Story.given<Model>(connected([info()])),
      Story.message(Message.ClickedRefresh()),
      Story.model((m: Model) => expect(AsyncData.isSuccess(m.processors)).toBe(true)),
      Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [] }))
    );
  });
});

describe("pause, resume and reset", () => {
  test("pause sends the action with the token, waits, says what it did, and reads the list again", () => {
    Story.story(
      update,
      Story.given<Model>(connected([info()])),
      Story.message(Message.ClickedPause({ kind: "views", id: "wallet-balance-view" })),
      Story.model((m: Model) => expect(m.acting).toEqual({ kind: "views", id: "wallet-balance-view", action: "pause" })),
      Story.Command.expectExact(ActOnProcessor({ token: "t0ken", action: "pause", kind: "views", id: "wallet-balance-view" })),
      Story.Command.resolve(ActOnProcessor, Message.SucceededAction({ action: "pause", kind: "views", id: "wallet-balance-view", status: "PAUSED" })),
      Story.model((m: Model) => {
        expect(m.acting).toBeNull();
        expect(m.notice).toEqual({ ok: true, text: describeAction("pause", "wallet-balance-view", "PAUSED") });
      }),
      Story.Command.expectExact(FetchProcessors({ token: "t0ken" })),
      Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [] }))
    );
  });

  test("while one action is in flight another is not sent", () => {
    Story.story(
      update,
      Story.given<Model>(connected([info()], { acting: { kind: "views", id: "a", action: "pause" } })),
      Story.message(Message.ClickedResume({ kind: "views", id: "b" })),
      Story.Command.expectNone()
    );
  });

  test("reset asks first: clicking only opens the confirmation, confirming sends it, cancelling sends nothing", () => {
    Story.story(
      update,
      Story.given<Model>(connected([info({ status: "FAILED", errorCount: 10 })])),
      Story.message(Message.ClickedReset({ kind: "views", id: "wallet-balance-view" })),
      Story.model((m: Model) => expect(m.confirmingReset).toEqual({ kind: "views", id: "wallet-balance-view" })),
      Story.Command.expectNone(),
      Story.message(Message.ConfirmedReset()),
      Story.model((m: Model) => {
        expect(m.confirmingReset).toBeNull();
        expect(m.acting).toEqual({ kind: "views", id: "wallet-balance-view", action: "reset" });
      }),
      Story.Command.expectExact(ActOnProcessor({ token: "t0ken", action: "reset", kind: "views", id: "wallet-balance-view" })),
      Story.Command.resolve(ActOnProcessor, Message.SucceededAction({ action: "reset", kind: "views", id: "wallet-balance-view", status: "ACTIVE" })),
      Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [] }))
    );
    Story.story(
      update,
      Story.given<Model>(connected([info()], { confirmingReset: { kind: "views", id: "x" } })),
      Story.message(Message.CancelledReset()),
      Story.model((m: Model) => expect(m.confirmingReset).toBeNull()),
      Story.Command.expectNone()
    );
    Story.story(update, Story.given<Model>(connected([info()])), Story.message(Message.ConfirmedReset()), Story.Command.expectNone());
  });

  test("a refusal is shown as such, the list is read again, and a 401 ends the session", () => {
    Story.story(
      update,
      Story.given<Model>(connected([info()], { acting: { kind: "views", id: "gone", action: "pause" } })),
      Story.message(Message.FailedAction({ action: "pause", kind: "views", id: "gone", problem: { _tag: "NotFound", detail: 'No processor "gone" of kind "views".' } })),
      Story.model((m: Model) => expect(m.notice).toEqual({ ok: false, text: 'Could not pause gone: No processor "gone" of kind "views".' })),
      Story.Command.expectExact(FetchProcessors({ token: "t0ken" })),
      Story.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [] }))
    );
    Story.story(
      update,
      Story.given<Model>(connected([info()], { acting: { kind: "views", id: "x", action: "pause" } })),
      Story.message(Message.FailedAction({ action: "pause", kind: "views", id: "x", problem: { _tag: "Unauthorized" } })),
      Story.model((m: Model) => expect(m.token).toBeNull()),
      Story.Command.expectNone()
    );
  });
});

describe("what the page says", () => {
  test("the buttons a processor gets follow its status", () => {
    expect(actionsFor({ status: "ACTIVE", errorCount: 0 })).toEqual(["pause"]);
    expect(actionsFor({ status: "ACTIVE", errorCount: 2 })).toEqual(["pause", "reset"]);
    expect(actionsFor({ status: "PAUSED", errorCount: 0 })).toEqual(["resume"]);
    expect(actionsFor({ status: "FAILED", errorCount: 10 })).toEqual(["reset"]);
    expect(actionsFor({ status: "ACTIVE", errorCount: null })).toEqual(["pause"]);
  });

  test("what waits, in words: nothing, unknown, a count with the age of the oldest, and a count that hit its cap", () => {
    expect(formatWaiting({ pendingEvents: 0, pendingCapped: false, oldestPendingSeconds: null })).toBe("nothing");
    expect(formatWaiting({ pendingEvents: null, pendingCapped: false, oldestPendingSeconds: null })).toBe("unknown");
    expect(formatWaiting({ pendingEvents: 1234, pendingCapped: false, oldestPendingSeconds: 42 })).toBe("1,234, oldest 42 s");
    expect(formatWaiting({ pendingEvents: 100000, pendingCapped: true, oldestPendingSeconds: 7200 })).toBe("at least 100,000, oldest 2.0 h");
  });

  test("ages", () => {
    expect([formatAge(12), formatAge(89), formatAge(120), formatAge(3000), formatAge(5400), formatAge(36000)]).toEqual(["12 s", "89 s", "2 min", "50 min", "1.5 h", "10.0 h"]);
  });

  test("reset says it does not move the cursor", () => {
    expect(describeAction("reset", "v", "ACTIVE")).toContain("cursor did not move");
  });

  test("every problem has words", () => {
    expect(describeProblem({ _tag: "Unauthorized" })).toBe("The application refused this token.");
    expect(describeProblem({ _tag: "Unreachable" })).toBe("The application could not be reached.");
    expect(describeProblem({ _tag: "NotFound", detail: "x" })).toBe("x");
    expect(describeProblem({ _tag: "Mismatch", detail: "a\nb" })).toContain("a b");
  });
});

describe("the page as a person uses it", () => {
  test("connect with a token, see the processors, and a FAILED one offers Reset behind a confirmation", () => {
    const failed = info({ id: "wallet-summary-view", status: "FAILED", errorCount: 10, lastError: "projection exploded" });
    Scene.scene(
      { update, view },
      Scene.given<Model>(start),
      Scene.inside(Scene.role("form", { name: "Connect form" }), Scene.type(Scene.role("textbox", { name: "Admin token" }), "s3cret"), Scene.submit(Scene.role("form", { name: "Connect form" }))),
      Scene.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [info(), failed] })),
      (Scene.expect(Scene.text("projection exploded")) as any).toExist(),
      (Scene.expect(Scene.text("The balance of each wallet")) as any).toExist(),
      Scene.click(Scene.role("button", { name: "Reset wallet-summary-view" })),
      (Scene.expect(Scene.role("alertdialog", { name: "Confirm reset" })) as any).toExist(),
      Scene.inside(Scene.role("alertdialog", { name: "Confirm reset" }), Scene.click(Scene.role("button", { name: "Reset" }))),
      Scene.Command.expectExact(ActOnProcessor({ token: "s3cret", action: "reset", kind: "views", id: "wallet-summary-view" })),
      Scene.Command.resolve(ActOnProcessor, Message.SucceededAction({ action: "reset", kind: "views", id: "wallet-summary-view", status: "ACTIVE" })),
      Scene.Command.resolve(FetchProcessors, Message.SucceededList({ processors: [info(), { ...failed, status: "ACTIVE", errorCount: 0, lastError: null }] })),
      (Scene.expect(Scene.text("Reset wallet-summary-view: its error count is cleared and it is ACTIVE. Its cursor did not move.")) as any).toExist()
    );
  });

  test("an error with a zero count is shown as history; one with a count is shown as current", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(connected([info({ id: "recovered", errorCount: 0, lastError: "broker down" })])),
      (Scene.expect(Scene.text("the last error, from before it was reset or recovered")) as any).toExist()
    );
    Scene.scene(
      { update, view },
      Scene.given<Model>(connected([info({ id: "failing", errorCount: 2, lastError: "broker down" })])),
      (Scene.expect(Scene.text("broker down")) as any).toExist(),
      (Scene.expect(Scene.text("the last error, from before it was reset or recovered")) as any).not.toExist()
    );
  });

  test("an empty application says so", () => {
    Scene.scene({ update, view }, Scene.given<Model>(connected([])), (Scene.expect(Scene.text("The application reports no processors.")) as any).toExist());
  });

  test("a paused processor offers Resume, not Pause", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(connected([info({ status: "PAUSED" })])),
      (Scene.expect(Scene.role("button", { name: "Resume wallet-balance-view" })) as any).toExist(),
      (Scene.expect(Scene.role("button", { name: "Pause wallet-balance-view" })) as any).not.toExist()
    );
  });
});
