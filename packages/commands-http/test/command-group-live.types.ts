// Compile-time tests (never executed): the command group's layer type is derived by `HttpApiBuilder.group` from the handlers (no cast to a layer type), and is what
// a caller provides: the executor, and nothing it can fail with.
import type { Layer } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import type { CommandExecutor } from "@crablet/commands";
import type { CommandApiRequirements, makeCommandApiGroupLive } from "../src/CommandApiLive.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Parts<L> = L extends Layer.Layer<infer A, infer E, infer R> ? { readonly out: A; readonly error: E; readonly needs: R } : never;
type Built = Parts<ReturnType<typeof makeCommandApiGroupLive<"shop", HttpApiGroup.Constraint, readonly []>>>;

export const needsTheExecutorOnly: Equal<CommandApiRequirements, CommandExecutor> = true;
export const needsTheExecutor: Equal<Built["needs"], CommandExecutor> = true;
export const cannotFail: Equal<Built["error"], never> = true;
export const servesTheCommandsGroupOfThatApi: Equal<Built["out"], HttpApiGroup.Service<"shop", "commands">> = true;
// (the api parameter is the caller's, of any groups)
export type TakesAnyApi = Parameters<typeof makeCommandApiGroupLive<"shop", HttpApiGroup.Constraint, readonly []>>[0] extends HttpApi.HttpApi<"shop", HttpApiGroup.Constraint> ? true : false;
