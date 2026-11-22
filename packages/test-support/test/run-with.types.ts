// Compile-time tests (never executed): `runWith`'s `run` takes exactly what its layer provides.
import { Context, Effect, Layer } from "effect";
import { runWith } from "../src/RunWith.ts";

class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<number> }>()("test/Clock") {}
class Mailer extends Context.Service<Mailer, { readonly send: (to: string) => Effect.Effect<void> }>()("test/Mailer") {}
class NotConnected {
  readonly _tag = "NotConnected";
}

const clockLayer: Layer.Layer<Clock, NotConnected> = Layer.succeed(Clock, { now: Effect.succeed(0) });
const { run, runExit } = runWith(clockLayer);

// what the layer provides runs
export const runsWhatTheLayerProvides: Promise<number> = run(Effect.flatMap(Clock, (c) => c.now));
// @ts-expect-error the layer does not provide a Mailer
run(Effect.flatMap(Mailer, (m) => m.send("x")));
// the layer's construction error is in the Exit, beside the effect's own
export const exitCarriesTheLayerError: Promise<import("effect").Exit.Exit<number, string | NotConnected>> = runExit(
  Effect.flatMap(Clock, (c) => c.now).pipe(Effect.flatMap((n) => (n > 0 ? Effect.succeed(n) : Effect.fail("zero"))))
);
// a thunk is accepted, and typed the same way
const fromThunk = runWith(() => clockLayer);
// @ts-expect-error the thunk's layer does not provide a Mailer either
fromThunk.run(Effect.flatMap(Mailer, (m) => m.send("x")));
