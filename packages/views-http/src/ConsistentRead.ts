import { Clock, Duration, Effect, Metric } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { HttpApiSchema } from "effect/http-api";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import * as ReadConsistencyMetrics from "@crablet/metrics-otel/ReadConsistencyMetrics";
import type { ViewSubscription } from "@crablet/views/ViewSubscription";
import { waitUntilProcessed } from "@crablet/views/WaitUntilProcessed";
import { headOfLog } from "./HeadOfLog.ts";
import {
  defaultReadConsistency,
  resolveReadPolicy,
  type ConsistencyParams,
  type EndpointConsistency,
  type ReadConsistencyConfig
} from "./ReadConsistency.ts";
import { ViewsUnavailable } from "./ReadProblems.ts";
import { waitForViews, type ViewWait } from "./WaitForViews.ts";

// What the wrapper needs from the database: the head of the log, and how to wait for one view. The real ones are `headOfLog` and
// `waitUntilProcessed`; tests pass fakes.
export interface ReadDeps<R = SqlClient.SqlClient> {
  readonly head: Effect.Effect<ProgressCursor.ProgressCursor, SqlError, R>;
  readonly wait: ViewWait<R>;
}

export interface ConsistentReadOptions<R = SqlClient.SqlClient> {
  // The API-wide settings (default: strict, a read with no marker waits for the head of the log, 5 s, at most 30 s, no relaxing).
  readonly config?: ReadConsistencyConfig;
  // The `Retry-After` of a strict read that timed out, in seconds (default 1).
  readonly retryAfterSeconds?: number;
  readonly deps?: ReadDeps<R>;
}

// Describes one read endpoint to the wrapper.
export interface ReadSpec<Request, Parsed, E, R> {
  // The views the endpoint reads, or a function of its parsed parameters when a filter selects different views. They are subscriptions,
  // not names: the wait needs each view's event selection to know when nothing relevant is pending.
  readonly reads: ReadonlyArray<ViewSubscription> | ((parsed: Parsed) => ReadonlyArray<ViewSubscription>);
  // Validates the endpoint's OWN parameters (limit, cursor, filters). It runs before any waiting, so a bad request is a 400 at once and
  // never waits. Fail with the endpoint's 400.
  readonly parse: (request: Request) => Effect.Effect<Parsed, E, R>;
  // This endpoint's own settings, over the API-wide ones.
  readonly consistency?: EndpointConsistency;
}

export interface ConsistentHeaders {
  readonly "crablet-consistency"?: "stale";
}

// Wraps read endpoints so that they can be consistent with a write (ADR-0015). For each request, in this order:
//
//   1. the consistency parameters are validated (a 400 for a bad value, or a mode the server does not allow the client to choose);
//   2. the endpoint's own parameters are validated (`parse`);
//   3. unless no wait is wanted, the head of the log is read once; a marker beyond it is a 400 (it can only be forged or from another log);
//   4. every view the endpoint reads is waited for, at the same time, until it has reached the marker (or the head), up to the timeout;
//   5. all caught up: the handler runs. Not caught up: `strict` fails with a 503 naming each view that is behind, `bounded` runs the
//      handler anyway and marks the response stale.
//
// Nothing before step 4 waits, so a bad request never costs a timeout. A database failure while checking is a defect (a 500), not a
// verdict about the views. The result is the `withHeaders` value that the success schema `ReadSuccess(Body)` describes.
export const makeConsistentRead = <R = SqlClient.SqlClient>(options: ConsistentReadOptions<R> = {}) => {
  const config = options.config ?? defaultReadConsistency;
  const retryAfterSeconds = options.retryAfterSeconds ?? 1;
  const deps = options.deps ?? ({ head: headOfLog, wait: waitUntilProcessed } as unknown as ReadDeps<R>);

  return <Request extends { readonly query: ConsistencyParams }, Parsed, E1, R1, A, E2, R2>(
    spec: ReadSpec<Request, Parsed, E1, R1>,
    run: (parsed: Parsed, request: Request) => Effect.Effect<A, E2, R2>
  ) =>
    (request: Request): Effect.Effect<HttpApiSchema.withHeaders<A, ConsistentHeaders>, E1 | E2 | CommandApiBadRequest | ViewsUnavailable, R | R1 | R2> =>
      Effect.gen(function* () {
        const resolution = resolveReadPolicy(config, spec.consistency ?? {}, request.query);
        if (!resolution.ok) return yield* Effect.fail(CommandApiBadRequest.of(resolution.detail));
        const policy = resolution.policy;
        const parsed = yield* spec.parse(request);
        const subscriptions = typeof spec.reads === "function" ? spec.reads(parsed) : spec.reads;

        const count = (outcome: "skipped" | "caught_up" | "stale" | "timeout" | "view_failed") =>
          Metric.update(Metric.withAttributes(ReadConsistencyMetrics.reads, { mode: policy.mode, outcome }), 1);
        const answer = (stale: boolean) =>
          Effect.map(run(parsed, request), (body) => {
            const headers: ConsistentHeaders = stale ? { "crablet-consistency": "stale" } : {};
            return HttpApiSchema.withHeaders({ body, headers });
          });

        if (policy.target._tag === "None") {
          yield* count("skipped");
          return yield* answer(false);
        }

        const head = yield* Effect.orDie(deps.head);
        let write: ProgressCursor.ProgressCursor;
        if (policy.target._tag === "Latest") {
          write = head;
        } else {
          write = ProgressCursor.of(policy.target.marker.transactionId, policy.target.marker.position);
          if (ProgressCursor.compare(write, head) > 0) {
            return yield* Effect.fail(CommandApiBadRequest.of("consistentWith is beyond the end of the log: it is not a marker this service returned"));
          }
        }
        if (subscriptions.length === 0) {
          yield* count("skipped");
          return yield* answer(false);
        }

        const startedAt = yield* Clock.currentTimeMillis;
        const outcome = yield* Effect.orDie(waitForViews(subscriptions, write, policy.timeoutMs, deps.wait));
        const waited = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Metric.update(Metric.withAttributes(ReadConsistencyMetrics.waitDuration, { mode: policy.mode }), Duration.millis(waited));

        if (outcome._tag === "CaughtUp") {
          yield* count("caught_up");
          return yield* answer(false);
        }
        if (policy.mode === "bounded") {
          yield* count("stale");
          return yield* answer(true);
        }
        yield* count(outcome.reason === "view_failed" ? "view_failed" : "timeout");
        return yield* Effect.fail(ViewsUnavailable.of(outcome, { timeoutMs: policy.timeoutMs, retryAfterSeconds }));
      });
};
