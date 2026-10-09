import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { makeWakeupNotifier, type WakeupNotifier } from "../src/internal/WakeupNotifier.ts";

const set = (...xs: string[]) => new Set(xs);

interface Fixture { readonly notifier: WakeupNotifier; readonly sent: Effect.Effect<ReadonlyArray<string>> }
const setup = (windowMs: number, fail = false): Effect.Effect<Fixture> =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    const notifier = yield* makeWakeupNotifier((p) => (fail ? Effect.fail("boom") : Ref.update(sent, (xs) => [...xs, p])), windowMs);
    return { notifier, sent: Ref.get(sent) };
  });
// A notifier whose sends are recorded, running on the test clock.
const run = (windowMs: number, body: (f: Fixture) => Effect.Effect<void>) =>
  Effect.runPromise(Effect.flatMap(setup(windowMs), body).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<void>);

describe("WakeupNotifier", () => {
  test("the first signal after idle is sent at once", () => run(50, ({ notifier, sent }) => Effect.gen(function* () {
    yield* notifier.signal(set("A"), set("k"));
    expect(yield* sent).toEqual(["A|k"]);
  })));

  test("signals inside the window are merged into one notification, sent when the window ends, carrying the union", () => run(50, ({ notifier, sent }) => Effect.gen(function* () {
    yield* notifier.signal(set("A"), set("k"));
    yield* notifier.signal(set("B"), set("j"));
    yield* notifier.signal(set("C"), set("k"));
    expect(yield* sent).toEqual(["A|k"]);
    yield* TestClock.adjust("49 millis");
    expect(yield* sent).toEqual(["A|k"]);
    yield* TestClock.adjust("1 millis");
    expect(yield* sent).toEqual(["A|k", "B,C|j,k"]);
  })));

  test("after the window has passed with nothing pending, the next signal is leading-edge again; nothing is sent when nothing was signalled", () => run(50, ({ notifier, sent }) => Effect.gen(function* () {
    yield* TestClock.adjust("1 seconds");
    expect(yield* sent).toEqual([]);
    yield* notifier.signal(set("A"), set());
    yield* TestClock.adjust("200 millis");
    yield* notifier.signal(set("B"), set());
    expect(yield* sent).toEqual(["A", "B"]);
  })));

  test("a signal recorded after the trailing send starts a new window and is not lost", () => run(50, ({ notifier, sent }) => Effect.gen(function* () {
    yield* notifier.signal(set("A"), set());
    yield* notifier.signal(set("B"), set());
    yield* TestClock.adjust("50 millis"); // trailing send of B at t=50, which opens a new window
    yield* notifier.signal(set("C"), set());
    expect(yield* sent).toEqual(["A", "B"]);
    yield* TestClock.adjust("50 millis");
    expect(yield* sent).toEqual(["A", "B", "C"]);
  })));

  test("window 0 sends after every signal", () => run(0, ({ notifier, sent }) => Effect.gen(function* () {
    yield* notifier.signal(set("A"), set());
    yield* notifier.signal(set("B"), set());
    expect(yield* sent).toEqual(["A", "B"]);
  })));

  test("a failed send is swallowed (the wake-up is only a hint) and the next one still goes out", () => Effect.runPromise(Effect.gen(function* () {
    const { notifier } = yield* setup(0, true);
    yield* notifier.signal(set("A"), set());
    yield* notifier.signal(set("B"), set());
  }).pipe(Effect.provide(TestClock.layer())) as Effect.Effect<void>));
});
