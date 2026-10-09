// The page's calls to the lab server, and what can go wrong with each. Everything about the wire format is in ./contract.ts, which the server encodes with.
// It imports no foldkit, so the tests can use it.
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Ack, State } from "./contract.ts";

export { Ack, State };

// What a call can fail with, as the page understands it.
export const Problem = Schema.Union([
  // The server is not running, or not where the page expects it.
  Schema.TaggedStruct("Unreachable", {}),
  // The server answered, but not with what the contract says: a field one side changed and the other did not.
  Schema.TaggedStruct("Mismatch", { detail: Schema.String })
]);
export type Problem = typeof Problem.Type;

const decode = <A, I>(schema: Schema.Codec<A, I>) => (json: unknown) => Schema.decodeUnknownEffect(schema)(json);

export const stateCall = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.get("/api/state"));
  return yield* decode(State as never as Schema.Codec<State, unknown>)(yield* response.json);
});

// A command to the server (start or stop a run, kill a pod, set the load, verify, empty the database). `body` is already JSON text.
export const sendCall = (path: string, body: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(path).pipe(HttpClientRequest.bodyText(body, "application/json"));
    const response = yield* client.execute(request);
    return yield* decode(Ack as never as Schema.Codec<typeof Ack.Type, unknown>)(yield* response.json);
  });

export const problemFromError = (error: unknown): Problem =>
  Schema.isSchemaError(error) ? { _tag: "Mismatch", detail: error.message.slice(0, 400) } : { _tag: "Unreachable" };
