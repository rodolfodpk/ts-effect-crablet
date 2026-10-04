import { parseMarker, type Marker } from "@crablet/eventstore/Marker";

// What a read may ask of the views it reads, and who decides (ADR-0015). Pure: no I/O, so the rules are tested as a table.
//
//   mode        what a timeout means: `strict` fails the read, `bounded` returns the data marked stale, `eventual` does not wait at all.
//   whenNoMarker  a read with no `consistentWith`: treat it as `latest` (wait for the head of the log) or `none` (do not wait).
//   timeoutMs   how long to wait; maxTimeoutMs is the most a request may ask for.
//   clientMayRelax  may a request choose a LOOSER mode than the endpoint's? (A stricter one is always allowed.)
export type ConsistencyMode = "strict" | "bounded" | "eventual";
export type WhenNoMarker = "latest" | "none";

export interface ReadConsistencyConfig {
  readonly mode: ConsistencyMode;
  readonly whenNoMarker: WhenNoMarker;
  readonly timeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly clientMayRelax: boolean;
}

// What an endpoint may override, one field at a time; anything it leaves out is the API-wide setting.
export type EndpointConsistency = Partial<ReadConsistencyConfig>;

// The server default is the consistent one: strict, and a read that sends no marker still waits for the head of the log.
export const defaultReadConsistency: ReadConsistencyConfig = {
  mode: "strict",
  whenNoMarker: "latest",
  timeoutMs: 5_000,
  maxTimeoutMs: 30_000,
  clientMayRelax: false
};

// The three query parameters of a read, as they arrive (plain strings: the wrapper validates them, so a bad value answers with the
// same problem body as every other 400).
export interface ConsistencyParams {
  readonly consistentWith?: string | undefined;
  readonly consistency?: string | undefined;
  readonly waitTimeout?: string | undefined;
}

// What to wait for: nothing, the head of the log as of the request, or a given write.
export type WaitTarget =
  | { readonly _tag: "None" }
  | { readonly _tag: "Latest" }
  | { readonly _tag: "Marker"; readonly marker: Marker };

export interface ReadPolicy {
  readonly mode: ConsistencyMode;
  readonly target: WaitTarget;
  readonly timeoutMs: number;
}

export type PolicyResolution =
  | { readonly ok: true; readonly policy: ReadPolicy }
  | { readonly ok: false; readonly detail: string };

const modes: ReadonlyArray<ConsistencyMode> = ["strict", "bounded", "eventual"];
// How much a mode demands: a request may choose a mode at least as demanding as the endpoint's, and a lower one only if allowed.
const strictness: Record<ConsistencyMode, number> = { strict: 2, bounded: 1, eventual: 0 };

const reject = (detail: string): PolicyResolution => ({ ok: false, detail });

// Combine the API-wide settings, the endpoint's own and the request's parameters into one policy, or say what is wrong with the request.
// The request is judged against the ENDPOINT's settings. Every parameter is validated even when it will not be used (a read that does not
// wait still gets a 400 for a malformed marker), and the first problem found is the one reported, in the order mode, timeout, marker.
export const resolveReadPolicy = (
  apiDefault: ReadConsistencyConfig,
  endpoint: EndpointConsistency,
  params: ConsistencyParams
): PolicyResolution => {
  const base: ReadConsistencyConfig = { ...apiDefault, ...endpoint };

  let mode = base.mode;
  if (params.consistency !== undefined) {
    const requested = modes.find((m) => m === params.consistency);
    if (requested === undefined) return reject(`consistency must be one of: ${modes.join(", ")}`);
    if (strictness[requested] < strictness[base.mode] && !base.clientMayRelax) {
      return reject(`consistency=${requested} is not allowed here; the lowest allowed is ${base.mode}`);
    }
    mode = requested;
  }

  let timeoutMs = Math.min(base.timeoutMs, base.maxTimeoutMs);
  if (params.waitTimeout !== undefined) {
    const requested = /^[0-9]+$/.test(params.waitTimeout) ? Number(params.waitTimeout) : NaN;
    if (!(requested >= 1 && requested <= base.maxTimeoutMs)) {
      return reject(`waitTimeout must be a whole number of milliseconds between 1 and ${base.maxTimeoutMs}`);
    }
    timeoutMs = requested;
  }

  let target: WaitTarget;
  if (params.consistentWith === undefined) {
    target = base.whenNoMarker === "latest" ? { _tag: "Latest" } : { _tag: "None" };
  } else if (params.consistentWith === "latest") {
    target = { _tag: "Latest" };
  } else {
    const marker = parseMarker(params.consistentWith);
    if (marker === null) {
      return reject(`consistentWith must be a marker from a command response ("<transactionId>:<position>") or "latest"`);
    }
    target = { _tag: "Marker", marker };
  }

  return { ok: true, policy: { mode, target: mode === "eventual" ? { _tag: "None" } : target, timeoutMs } };
};
