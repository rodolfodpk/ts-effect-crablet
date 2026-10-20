// Compile-time tests (never executed): `serveApi` serves an api whose every group is implemented, and a group left out stays a requirement of the
// layer, so serving it does not compile. A hand-written endpoint fails with `problemOf(error)`, typed from the error, checked against the endpoint.
import { Effect, type Layer } from "effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { defineCommand, emit } from "@crablet/commands/Command";
import { defineContract } from "@crablet/commands/Contract";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import { makeCommandApiGroup } from "../src/CommandApi.ts";
import type { CommandApiRequirements } from "../src/CommandApiLive.ts";
import { problemOf, problemSchemaOf } from "../src/ProblemDetail.ts";
import { serveApi } from "../src/ServeApi.ts";

type Expect<T extends true> = T;
// Whether the layer still needs `S`.
type Requires<L extends Layer.Any, S> = [Extract<Layer.Services<L>, S>] extends [never] ? false : true;

class NoSuchNote extends DomainError("NoSuchNote", { fields: { noteId: Schema.String }, kind: "not_found" }) {}
class NoteTaken extends DomainError("NoteTaken", { fields: { noteId: Schema.String }, kind: "conflict" }) {}
const Noted = defineEvent("SA_Noted", { schema: Schema.Struct({ noteId: Schema.String }), tags: (d) => ({ note_id: d.noteId }) });
const NoteContract = defineContract({ name: "note", input: Schema.Struct({ noteId: Schema.String }) });
const contracts = [NoteContract];
const Note = defineCommand({ ...NoteContract, idempotentBy: (c) => Noted.where({ note_id: c.noteId }), decide: (_, c) => emit(Noted(c)) });

const reads = HttpApiGroup.make("reads").add(
  HttpApiEndpoint.get("getNote", "/notes/:noteId", { params: { noteId: Schema.String }, success: Schema.Struct({ noteId: Schema.String }), error: [problemSchemaOf(NoSuchNote)] })
);
const api = HttpApi.make("sa").add(makeCommandApiGroup("/api/commands", contracts)).add(reads);

const readsLive = HttpApiBuilder.group(api, "reads", (handlers) =>
  Effect.succeed(handlers.handle("getNote", ({ params }) => Effect.fail(problemOf(new NoSuchNote({ noteId: params.noteId })))))
);

// Every group implemented: nothing of the api's groups is left to provide.
const served = serveApi(api, { commands: { contracts, implementations: { note: Note } }, groups: [readsLive] });
export type AllServed = Expect<Requires<typeof served, HttpApiGroup.Service<"sa", "reads">> extends false ? true : false>;
// (the check can see a requirement: the command group's own needs are there)
export type SeesRequirements = Expect<Requires<typeof served, HttpApiGroup.Service<"sa", "reads"> | CommandApiRequirements>>;

// The read group left out: it is still required, so the layer cannot be launched.
const missing = serveApi(api, { commands: { contracts, implementations: { note: Note } } });
export type MissingIsRequired = Expect<Requires<typeof missing, HttpApiGroup.Service<"sa", "reads">>>;

// A problem for an error the endpoint does not declare does not compile.
export const wrongProblem = HttpApiBuilder.group(api, "reads", (handlers) =>
  // @ts-expect-error NoteTaken is not one of getNote's errors
  Effect.succeed(handlers.handle("getNote", ({ params }) => Effect.fail(problemOf(new NoteTaken({ noteId: params.noteId })))))
);
