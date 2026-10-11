import { describe, expect, test } from "bun:test";
import { compile } from "../src/internal/ViewOpSql.ts";
import { bigint, decimal, integer, text, timestamptz, viewTable } from "../src/ViewTable.ts";

const summary = viewTable("wallet_summary_view", {
  key: { wallet_id: text() },
  columns: {
    total_deposits: decimal().default(0),
    current_balance: decimal().default(0),
    note: text().nullable(),
    last_transaction_at: timestamptz().nullable()
  }
});
const moves = viewTable("moves", {
  key: { transaction_id: text(), event_position: bigint() },
  columns: { amount: decimal(), count: integer().default(0) }
});

const c = (op: Parameters<typeof compile>[0]) => compile(op)!;

describe("compile", () => {
  test("insert, ignoring a row that exists", () => {
    expect(c(moves.insert({ transaction_id: "t1", event_position: 7n, amount: 5 }, { onConflict: "ignore" }) as never)).toEqual({
      text: 'INSERT INTO "moves" ("transaction_id", "event_position", "amount") VALUES ($1, $2, $3) ON CONFLICT ("transaction_id", "event_position") DO NOTHING',
      params: ["t1", "7", 5]
    });
  });

  test("insert, replacing the columns given", () => {
    expect(c(summary.insert({ wallet_id: "w", current_balance: 10, note: null }, { onConflict: "replace" }) as never)).toEqual({
      text: 'INSERT INTO "wallet_summary_view" ("wallet_id", "current_balance", "note") VALUES ($1, $2, $3) ON CONFLICT ("wallet_id") DO UPDATE SET "current_balance" = EXCLUDED."current_balance", "note" = EXCLUDED."note"',
      params: ["w", 10, null]
    });
  });

  test("update: add, set and max, then the key", () => {
    expect(c(summary.update({ wallet_id: "w" }, { add: { total_deposits: 3 }, set: { note: "x" }, max: { last_transaction_at: "2026-01-01T00:00:00Z" } }) as never)).toEqual({
      text: 'UPDATE "wallet_summary_view" SET "total_deposits" = "total_deposits" + $1, "note" = $2, "last_transaction_at" = GREATEST("last_transaction_at", $3) WHERE "wallet_id" = $4',
      params: [3, "x", "2026-01-01T00:00:00Z", "w"]
    });
  });

  test("an update that changes nothing compiles to nothing", () => {
    expect(compile(summary.update({ wallet_id: "w" }, {}) as never)).toBeNull();
  });

  test("upsert: the amounts start the row, and add to an existing one", () => {
    expect(c(summary.upsert({ wallet_id: "w" }, { add: { total_deposits: 3, current_balance: -3 }, max: { last_transaction_at: "2026-01-01T00:00:00Z" } }) as never)).toEqual({
      text: 'INSERT INTO "wallet_summary_view" ("wallet_id", "total_deposits", "current_balance", "last_transaction_at") VALUES ($1, $2, $3, $4) ON CONFLICT ("wallet_id") DO UPDATE SET "total_deposits" = "wallet_summary_view"."total_deposits" + EXCLUDED."total_deposits", "current_balance" = "wallet_summary_view"."current_balance" + EXCLUDED."current_balance", "last_transaction_at" = GREATEST("wallet_summary_view"."last_transaction_at", EXCLUDED."last_transaction_at")',
      params: ["w", 3, -3, "2026-01-01T00:00:00Z"]
    });
  });

  test("remove, with a composite key and a bigint", () => {
    expect(c(moves.remove({ transaction_id: "t1", event_position: 7n }) as never)).toEqual({
      text: 'DELETE FROM "moves" WHERE "transaction_id" = $1 AND "event_position" = $2',
      params: ["t1", "7"]
    });
  });

  test("one column changed two ways is refused", () => {
    expect(() => compile(summary.update({ wallet_id: "w" }, { add: { total_deposits: 1 }, set: { total_deposits: 2 } }) as never)).toThrow("changed twice");
  });

  test("a table or column that is not a plain lower-case identifier is refused", () => {
    expect(() => viewTable('bad"name', { key: { id: text() }, columns: {} })).toThrow("identifier");
    expect(() => viewTable("t", { key: { id: text() }, columns: { "Bad": text() } })).toThrow("identifier");
  });
});
