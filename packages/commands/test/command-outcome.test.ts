// What one execution ended as, and how it is reported (ADR-0056): the outcome, the span's status and attributes, the two metrics, and the caller's
// result unchanged.
import { describe, expect, test } from "bun:test";
import { Data, Effect, Exit, Metric, Schema, type Tracer } from "effect";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import * as LogPoint from "@crablet/eventstore/LogPoint";
import { DomainError, IdempotencyMismatch } from "../src/Errors.ts";
import { created, idempotent, type ExecutionResult } from "../src/ExecutionResult.ts";
import { outcomeOf, reportExecution, type Outcome } from "../src/CommandOutcome.ts";

class InsufficientFunds extends DomainError("InsufficientFunds", { fields: { walletId: Schema.String }, kind: "invalid" }) {}
class SqlError extends Data.TaggedError("SqlError")<{}> {}
const marker = LogPoint.of("1", 1n);
// The error the caller got, or null.
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => (Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error ?? null : null);

const rejected = new InsufficientFunds({ walletId: "w1" });
const conflict = new Conflict({ message: "stale", kind: "boundary" });
const mismatch = new IdempotencyMismatch({ message: "other request", command: "c" });

describe("outcomeOf", () => {
  const cases: ReadonlyArray<readonly [string, Exit.Exit<ExecutionResult, unknown>, Outcome]> = [
    ["created", Exit.succeed(created(marker)), { outcome: "created" }],
    ["idempotent", Exit.succeed(idempotent("repeat")), { outcome: "idempotent" }],
    ["a declared domain error", Exit.fail(rejected), { outcome: "rejected", error: "InsufficientFunds", kind: "invalid" }],
    ["an idempotency mismatch", Exit.fail(mismatch), { outcome: "mismatch" }],
    ["a conflict after the retries", Exit.fail(conflict), { outcome: "conflict" }],
    ["a SQL fault", Exit.fail(new SqlError()), { outcome: "error", error: "SqlError" }],
    ["a defect", Exit.die(new Error("boom")), { outcome: "error", error: "defect" }],
    ["an interruption", Exit.interrupt(1), { outcome: "error", error: "interrupted" }]
  ];
  for (const [what, exit, expected] of cases) test(what, () => expect(outcomeOf(exit)).toEqual(expected));
});

// A command named for one test, so its metric series are its own.
let n = 0;
const run = <E>(results: ReadonlyArray<Effect.Effect<ExecutionResult, E>>, correlationId?: string) => {
  const name = `outcome-test-${++n}`;
  let span: Tracer.Span | undefined;
  let i = 0;
  // the attempts: each takes the next result, and a Conflict is retried as the executor's withConflictRetry does
  const program = reportExecution({ name, retries: results.length - 1 }, (attempt) =>
    Effect.retry(
      attempt(Effect.flatMap(Effect.currentSpan.pipe(Effect.orDie), (s) => ((span = s), results[i++]!))),
      { times: results.length - 1, while: (e) => e instanceof Conflict }
    )
  );
  const withContext = correlationId === undefined ? program : CorrelationContext.withCorrelationId(correlationId)(program);
  return Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(withContext);
      const snapshots = (yield* Metric.snapshot).filter((s) => s.attributes?.["command_type"] === name);
      return { exit, span: span!, name, snapshots };
    })
  );
};
const statusOf = (span: Tracer.Span) => (span.status._tag === "Ended" ? (Exit.isSuccess(span.status.exit) ? "ok" : "failed") : "open");
const countOf = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string) =>
  snapshots.filter((s) => s.id === id).map((s): Record<string, unknown> => ({ ...s.attributes, count: (s.state as { count: number | bigint }).count }));

describe("reportExecution", () => {
  test("a created execution: the span is ok, with the outcome and the attempts, and one execution is counted", async () => {
    const { exit, span, name, snapshots } = await run([Effect.succeed(created(marker))]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(statusOf(span)).toBe("ok");
    expect(span.name).toBe("crablet.command");
    expect(Object.fromEntries(span.attributes)).toMatchObject({ "crablet.command.name": name, "crablet.command.outcome": "created", "crablet.command.attempts": 1 });
    expect(countOf(snapshots, "crablet.command.executions")).toEqual([{ command_type: name, outcome: "created", count: 1 }]);
    expect(snapshots.filter((s) => s.id === "crablet.command.execution.duration").map((s) => s.attributes?.["outcome"])).toEqual(["created"]);
  });

  test("a domain error is a business answer: the span is ok, and the caller still fails with the same error", async () => {
    const { exit, span, name, snapshots } = await run([Effect.fail(rejected)]);
    expect(failureOf(exit)).toBe(rejected);
    expect(statusOf(span)).toBe("ok");
    expect(Object.fromEntries(span.attributes)).toMatchObject({
      "crablet.command.outcome": "rejected",
      "crablet.command.error": "InsufficientFunds",
      "crablet.command.error_kind": "invalid"
    });
    expect(countOf(snapshots, "crablet.command.executions")).toEqual([{ command_type: name, outcome: "rejected", error: "InsufficientFunds", count: 1 }]);
  });

  test("an idempotent repeat and a mismatch end the span ok", async () => {
    expect(statusOf((await run([Effect.succeed(idempotent("repeat"))])).span)).toBe("ok");
    const m = await run([Effect.fail(mismatch)]);
    expect(statusOf(m.span)).toBe("ok");
    expect(failureOf(m.exit)).toBe(mismatch);
  });

  test("the outcome is the last attempt's: a conflict retried into a success is created, after two attempts", async () => {
    const { exit, span, name, snapshots } = await run([Effect.fail(conflict), Effect.succeed(created(marker))]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Object.fromEntries(span.attributes)).toMatchObject({ "crablet.command.outcome": "created", "crablet.command.attempts": 2 });
    expect(countOf(snapshots, "crablet.command.executions")).toEqual([{ command_type: name, outcome: "created", count: 1 }]);
  });

  test("a conflict that outlives the retries, and a fault, end the span failed and reach the caller", async () => {
    const c = await run([Effect.fail(conflict), Effect.fail(conflict)]);
    expect(statusOf(c.span)).toBe("failed");
    expect(failureOf(c.exit)).toBe(conflict);
    expect(Object.fromEntries(c.span.attributes)).toMatchObject({ "crablet.command.outcome": "conflict", "crablet.command.attempts": 2 });
    const f = await run([Effect.fail(new SqlError())]);
    expect(statusOf(f.span)).toBe("failed");
    expect(countOf(f.snapshots, "crablet.command.executions")).toEqual([{ command_type: f.name, outcome: "error", error: "SqlError", count: 1 }]);
  });

  test("the correlation id of the request is on the span, and absent without one", async () => {
    const id = "0193a6f0-0000-7000-8000-000000000001";
    expect(Object.fromEntries((await run([Effect.succeed(created(marker))], id)).span.attributes)["crablet.correlation_id"]).toBe(id);
    expect(Object.fromEntries((await run([Effect.succeed(created(marker))])).span.attributes)).not.toHaveProperty("crablet.correlation_id");
  });
});
