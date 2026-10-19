import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { Duplicate } from "@crablet/eventstore/AppendErrors";

// How a repeat of a request is told from a different request under the same key (ADR-0034). Internal: the command handler and the executor
// use it; applications see its outcome as an idempotent result or `IdempotencyMismatch`.

// JSON with the keys of every object sorted, so the same input always gives the same text. Bigints become strings, as in the audit.
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint"
      ? v.toString()
      : v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
        : v
  );

// The fingerprint of a request: SHA-256 (hex) of the command's name and its input, ENCODED by the command's own input schema, so two inputs
// that decode to the same value fingerprint the same. Web Crypto, so it runs in Node, Bun and a browser alike.
export const fingerprintOf = (name: string, inputSchema: Schema.Constraint, input: unknown): Effect.Effect<string> =>
  Effect.gen(function* () {
    const encoded = yield* Effect.orDie(Schema.encodeUnknownEffect(inputSchema)(input) as Effect.Effect<unknown, Schema.SchemaError>);
    const bytes = new TextEncoder().encode(`${name}\u0000${canonicalJson(encoded)}`);
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  });

// Is what the key matched this same request, or another one?
//   - the same trigger delivered again (a cause, the same as this attempt's): the same request, even if the input was rebuilt from state that
//     has changed since - the trigger's work is done;
//   - otherwise a stored fingerprint that differs from this one: another request under the same key;
//   - anything else (the same fingerprint, or events appended before fingerprints existed): the same request.
export const isSameRequest = (duplicate: Duplicate, fingerprint: string | null, causationId: bigint | null): boolean => {
  if (causationId !== null && duplicate.requests.some((r) => r.causationId === causationId)) return true;
  if (fingerprint === null) return true;
  return duplicate.requests.every((r) => r.fingerprint === null || r.fingerprint === fingerprint);
};
