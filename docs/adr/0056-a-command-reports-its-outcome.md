# ADR-0056: A command reports its outcome, and the served API its requests

## Status

**Proposed** (2026-11-28). Nothing built. The last item of the `@crablet/app` plan's "what this plan does not improve" list ("observability of the
commands and of HTTP"). Amends nothing; the metric names it adds follow `docs/reference/metrics.md`.

## Context

What a command and a request already report, read from the code:

- **A span per command**, `crablet.command` (`CommandExecutor.ts`, `runDecoded`): the whole execution, retries included, with
  `crablet.command.name` and `crablet.command.max_retries`. The reads and the append are its children (`crablet.eventstore.project`,
  `crablet.eventstore.append`).
- **A span per request**, from Effect's own server (`HttpMiddleware.tracer`, effect 4.1.4): `http.request.method`, the URL,
  `http.response.status_code`, and `http.route` set by the router. A command run by `serveApi` runs in the request's fiber, so its span is a child
  of the request's: one trace goes from the request to the append already. Effect's `HttpMiddleware.logger` writes the `http.span=…ms` log lines.
- **Command metrics** (`@crablet/metrics-otel/CommandMetrics`), all by `command_type`: `crablet.command.handle.duration`, `.successes` and
  `.failures`, recorded by `observe` around **each attempt** (one transaction), and three counters: `idempotent_duplicates`,
  `idempotency_mismatches`, `conflict_retries`. The dashboard's command panels read them ("Failed attempts/s", "Command p95", "Commands per second").
- **No HTTP metric.** Effect 4.1.4 has a tracer and a logger middleware, and no metrics middleware.

What is missing:

1. **What a command ended as.** The span does not say it. `handle.failures` counts per attempt and mixes three different things:
   - a declared domain error (`WalletIsClosed`, kind `conflict`), which is a business answer, not a fault;
   - a `Conflict` that the next attempt retries;
   - a fault (`SqlError`, `AppendTooLarge`, an exhausted retry, a defect).

   An alert on "failures" fires on customers being told "insufficient funds". An idempotent repeat counts as a success, and separately in
   `idempotent_duplicates`. Effect's `withSpan` marks the span failed for every failure, so a domain error is an error span in every trace backend.
2. **Requests by route and status.** The rate of 4xx and 5xx per command or read, and the latency per route, are only in traces, which are sampled.
3. **The way from a trace to the log.** A command's events carry a `correlationId` (ADR-0051); its span does not, so a trace cannot be matched to the
   events it wrote, or the other way round.

The command's outcome is already a type: `ExecutionResult` (created or idempotent) or the `E` of `run` (the declared domain errors,
`IdempotencyMismatch`, `Conflict`, `AppendTooLarge`, `SqlError`). Reporting it adds no concept for the application: it is the same answer, counted.

## Decision

1. **One outcome per execution, from the command's own result.** After the retries, an execution is exactly one of:

   | `outcome` | when |
   |---|---|
   | `created` | it appended |
   | `idempotent` | a repeat, or a decision that did nothing (`noop`) |
   | `rejected` | a declared domain error; with `error` (its tag) and `kind` (`not_found`, `invalid`, `conflict`, `forbidden`) |
   | `mismatch` | `IdempotencyMismatch`: the same key with another request |
   | `conflict` | `Conflict` after the last retry |
   | `error` | anything else: `SqlError`, `AppendTooLarge`, an `EventDecodingError`, a defect; with `error` (the tag or `defect`) |

   `error` takes its values from the declared errors and the framework's few: a bounded set, fixed by the code, never a message.
2. **The span says it.** `crablet.command` gains `crablet.command.outcome`, `crablet.command.attempts`, and, when present, `crablet.command.error`,
   `crablet.command.error_kind` and `crablet.correlation_id`. A `rejected`, `idempotent` or `mismatch` execution ends its span **ok**: the
   executor turns the declared error into a value inside the span and fails with it again outside, so `E` does not change. `conflict` and `error`
   end it failed, as now.
3. **One counter and one timer per execution**, beside the per-attempt ones: `crablet.command.executions` (counter) and
   `crablet.command.execution.duration` (timer), by `command_type` and `outcome`, and `error` for `rejected` and `error`. The attempt triplet
   (`handle.*`) and the three counters stay: they answer "how hard is the store working", the new pair "what did the callers get". The dashboard
   gains a panel of executions by outcome; the alert on faults reads `outcome="error"`, never `rejected`.
4. **The served API counts its requests.** `serveApi` (`@crablet/commands-http`, ADR-0042), which every application's API goes through, adds a
   middleware that records `http.server.request.duration` (a timer) by `http.request.method`, `http.route` and `http.response.status_code`: the
   OpenTelemetry semantic-convention name and attributes, which backends already chart, rather than a `crablet.` name. The route is the router's
   template (`/api/wallets/:walletId`), never the URL; a command's route is its own (`POST /api/commands/open_wallet`), so the
   series is per command with no extra attribute. It lives in `commands-http` because `serveApi` does, and so it covers
   the reads (`views-http`) and the admin (`processors-http`) served by the same layer; no package gains `@effect/platform-node`.
5. **Where they are defined.** The two command metrics in `@crablet/metrics-otel/CommandMetrics`, the HTTP one in a new
   `@crablet/metrics-otel/HttpMetrics`; all in `docs/reference/metrics.md` and in the dashboard (`scripts/dashboard.test.ts`).

## Consequences

- An operator can tell a fault from a business answer: an alert on `outcome="error"`, a panel of `rejected` by `error` (what customers are told
  most), the conflicts that exhausted their retries. Traces show domain errors as ok spans with their outcome, and a trace can be looked up by
  the `correlationId` of an event.
- Two more series per command and outcome, and one per route and status class. The `error` attribute multiplies the `rejected` series by the
  command's declared errors: a handful per command, fixed by the code.
- `http.server.request.duration` is the one name not under `crablet.`: the HTTP layer is Effect's and OpenTelemetry's convention, not the
  framework's; `docs/reference/metrics.md` says so.
- Breaks to add (`scripts/breaks.ts`): a domain error counted as `error`; the outcome taken from the first attempt instead of the last; the URL
  used instead of the route.
- Not done: a trace id stored in the events' metadata (the way from the log to a trace without the `correlationId`); a span per view batch with its
  causation. Both are possible later and change nothing here.

## Before accepting

- Effect 4.1.4's `Metric.withAttributes` takes an attribute chosen after the effect finished (the executor already does it for
  `idempotent_duplicates`): confirm for a timer, so the outcome goes on the duration. `observe`'s comment says it cannot (written against Effect 3);
  correct the comment either way.
- A span ended ok for a value and then failed outside it: confirm in a test with an in-memory tracer that the backend sees ok and the caller the
  same `E`.
- `http.route` is set before the middleware reads it (the router sets it on the request's span, `HttpRouter.js`): confirm, or take the route from
  `HttpRouter` another way, with a test that a path parameter does not appear in the series.
