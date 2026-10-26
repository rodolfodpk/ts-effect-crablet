import { describe, expect, test } from "bun:test";
import { Effect, Logger } from "effect";
import type { SqlClient } from "effect/sql";
import { checkIdleInTransactionOnce, idleInTransactionWarning } from "../src/ServerSettings.ts";

// A pod cut off in the middle of a transaction stalls every poller until the server ends its session (ServerSettings.ts); with
// idle_in_transaction_session_timeout at 0 that is when TCP keepalives give up. The framework says so when it is off.
describe("idleInTransactionWarning", () => {
  test("off (0) warns, and names the setting and where to set it", () => {
    const warning = idleInTransactionWarning("0")!;
    expect(warning).toContain("idle_in_transaction_session_timeout");
    expect(warning).toMatch(/server/);
  });

  test("any timeout says nothing", () => {
    expect(idleInTransactionWarning("15s")).toBeNull();
    expect(idleInTransactionWarning("2000ms")).toBeNull();
    expect(idleInTransactionWarning("1min")).toBeNull();
  });
});

describe("checkIdleInTransactionOnce", () => {
  // A client whose reads answer `answers` in turn (an Error: the read fails).
  const fakeSql = (answers: Array<string | Error>) => {
    let reads = 0;
    const sql = (() => {
      const answer = answers[reads++]!;
      return answer instanceof Error ? Effect.fail(answer) : Effect.succeed([{ value: answer }]);
    }) as unknown as SqlClient.SqlClient;
    return { sql, reads: () => reads };
  };
  const warningsOf = async (effect: Effect.Effect<void>) => {
    const lines: Array<unknown> = [];
    const capture = Logger.layer([Logger.make((options) => void lines.push(options.message))], { mergeWithExisting: false });
    await Effect.runPromise(effect.pipe(Effect.provide(capture)));
    return lines.map(String).filter((l) => l.includes("idle_in_transaction_session_timeout"));
  };

  test("warns once per client, however many modules start on it", async () => {
    const { sql, reads } = fakeSql(["0", "0", "0"]);
    const check = checkIdleInTransactionOnce(sql);
    expect(await warningsOf(Effect.all([check, check, check], { discard: true }))).toHaveLength(1);
    expect(reads()).toBe(1);
  });

  test("a timeout that is set says nothing", async () => {
    const { sql } = fakeSql(["15s"]);
    expect(await warningsOf(checkIdleInTransactionOnce(sql))).toHaveLength(0);
  });

  test("a read that fails is not a finding: it says nothing, and the next start reads again", async () => {
    const { sql, reads } = fakeSql([new Error("connection refused"), "0"]);
    expect(await warningsOf(checkIdleInTransactionOnce(sql))).toHaveLength(0);
    expect(await warningsOf(checkIdleInTransactionOnce(sql))).toHaveLength(1);
    expect(reads()).toBe(2);
  });
});
