// Compile-time tests (never executed): what the health routes need, read off their type.
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { Processors } from "@crablet/modules/Processors";
import { healthRoutes } from "../src/Health.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type RequirementsOf<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
type ErrorOf<L> = L extends Layer.Layer<infer _A, infer E, infer _R> ? E : never;
type Health = ReturnType<typeof healthRoutes>;

// The router and the process's modules, nothing else: no database client (the ping is given), no executor.
export const needsTheRouterAndProcessors: Equal<RequirementsOf<Health>, HttpRouter.HttpRouter | Processors> = true;
// It cannot fail to build: a failing ping is a 503, not an error of the layer.
export const neverFails: Equal<ErrorOf<Health>, never> = true;

// The ping is a ready query: one that needs a service would make every request need it.
class Pool extends Context.Service<Pool, { readonly query: Effect.Effect<void> }>()("test/Pool") {}
// @ts-expect-error the ping must need no service
healthRoutes({ ping: Effect.flatMap(Pool.asEffect(), (p) => p.query) });

// Served without `Processors`, the routes do not compile.
const served = (routes: Layer.Layer<never, never, HttpRouter.HttpRouter>) => HttpRouter.toWebHandler(routes);
// @ts-expect-error `Processors` is not provided
served(healthRoutes({ ping: Effect.void }));
served(healthRoutes({ ping: Effect.void }).pipe(Layer.provide(Layer.succeed(Processors, { sources: [], status: Effect.succeed([]) }))));
