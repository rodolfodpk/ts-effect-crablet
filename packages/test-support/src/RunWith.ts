// Running an Effect in a test, typed by the layer that runs it. `run` takes exactly what the layer provides, so a test that needs a service the layer
// does not build does not compile, where a helper typed `Effect<A, E, any>` and cast to `never` would fail at run time with "service not found"
// (CLAUDE.md, "Type safe"). The error channel is honest too: a failure of the layer to build (the pool cannot connect, a `SqlError`) is in the
// `Exit` of `runExit`, beside the effect's own errors.
//
//     const { run, runExit } = runWith(() => Crablet.layer(connInfo));   // a thunk: the layer is built per call, as `Effect.provide(e, AppLive())` was
//     const { run } = runWith(layer);                                     // or one layer value, for a layer made once
//
// Each call provides the layer anew, so each builds what the layer builds (a pool, for a database layer); a test that wants one shared instance makes
// a `ManagedRuntime` instead.
import { Effect, type Exit, type Layer } from "effect";

export interface RunWith<ROut, LE> {
  // Runs `effect` with the layer, resolving with its value; rejects with the failure (the effect's, or the layer's).
  readonly run: <A, E>(effect: Effect.Effect<A, E, ROut>) => Promise<A>;
  // Runs `effect` with the layer and resolves with its `Exit`, whose error is the effect's or the layer's.
  readonly runExit: <A, E>(effect: Effect.Effect<A, E, ROut>) => Promise<Exit.Exit<A, E | LE>>;
}

export const runWith = <ROut, LE>(layer: Layer.Layer<ROut, LE> | (() => Layer.Layer<ROut, LE>)): RunWith<ROut, LE> => {
  const layerOf = typeof layer === "function" ? layer : () => layer;
  return {
    run: (effect) => Effect.runPromise(Effect.provide(effect, layerOf())),
    runExit: (effect) => Effect.runPromiseExit(Effect.provide(effect, layerOf()))
  };
};
