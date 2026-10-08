import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import { withConflictRetry } from "../src/CommandExecutor.ts";

const conflict = (message: string) => new Conflict({ message, kind: "boundary" });

// An attempt that fails with a Conflict a given number of times, then succeeds; counts how often it ran.
const flaky = (failures: number) => {
  let runs = 0;
  const attempt = Effect.suspend(() => {
    runs++;
    return runs <= failures ? Effect.fail(conflict(`conflict ${runs}`)) : Effect.succeed(`done after ${runs}`);
  });
  return { attempt, runs: () => runs };
};

describe("withConflictRetry", () => {
  test("a Conflict is retried until the attempt succeeds, as long as retries remain", async () => {
    const f = flaky(2);
    expect(await Effect.runPromise(withConflictRetry(3, f.attempt))).toBe("done after 3");
    expect(f.runs()).toBe(3);
  });

  test("when the retries run out the LAST conflict is reported, after exactly retries + 1 attempts", async () => {
    const f = flaky(10);
    const exit = await Effect.runPromiseExit(withConflictRetry(2, f.attempt));
    expect(f.runs()).toBe(3);
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("conflict 3");
  });

  test("with no retries a Conflict is reported at once", async () => {
    const f = flaky(1);
    expect(Exit.isFailure(await Effect.runPromiseExit(withConflictRetry(0, f.attempt)))).toBe(true);
    expect(f.runs()).toBe(1);
  });

  test("a failure that is not a Conflict is never retried", async () => {
    let runs = 0;
    const exit = await Effect.runPromiseExit(withConflictRetry(5, Effect.suspend(() => { runs++; return Effect.fail(new Error("boom")); })));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(runs).toBe(1);
  });

  test("onRetry runs before each re-run, and not before the first run", async () => {
    const order: Array<string> = [];
    let runs = 0;
    const attempt = Effect.suspend(() => {
      runs++;
      order.push(`run ${runs}`);
      return runs < 3 ? Effect.fail(conflict("c")) : Effect.succeed("ok");
    });
    await Effect.runPromise(withConflictRetry(5, attempt, Effect.sync(() => order.push("retry"))));
    expect(order).toEqual(["run 1", "retry", "run 2", "retry", "run 3"]);
  });
});
