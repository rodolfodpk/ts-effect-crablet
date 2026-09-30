// The conformance suite: what ANY EventStore implementation must do. The same cases run against the
// in-memory store (test/conformance-in-memory.test.ts, Bun) and against real Postgres
// (test/integration/conformance-postgres.test.ts, Node + Testcontainers). Where they agree, the
// in-memory store is a faithful stand-in for decision-logic tests; where a case fails on only one,
// that implementation has a bug (or the spec in src/spec/Spec.ts is wrong).
//
// Framework-neutral on purpose: a case is a plain async function using node:assert. Cases share one
// store, so each isolates itself with unique tag values / event types (`unique()`).
import assert from "node:assert/strict";
import { Cause, Effect, Exit } from "effect";
import { EventStore } from "../../src/EventStore.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import { append, ev, existsQuery, headPosition, item, positionOf, read, tagStrings, uid, type Harness } from "./ops.ts";

export type { Harness } from "./ops.ts";
export interface ConformanceCase {
  readonly name: string;
  readonly run: (h: Harness) => Promise<void>;
}

export const cases: ReadonlyArray<ConformanceCase> = [
  {
    name: "an unconditional append stores the event; reading it back returns type, tags and data",
    run: async (h) => {
      const id = uid();
      assert.equal(await append(h, [ev("ConfA", [["k", id]], { hello: "world" })]), "ok");
      const { state } = await read(h, Query.forEventAndTag("ConfA", "k", id));
      assert.equal(state.length, 1);
      assert.equal(state[0]!.type, "ConfA");
      assert.deepEqual(tagStrings(state[0]!), [`k=${id}`]);
      assert.deepEqual(state[0]!.data, { hello: "world" });
    }
  },
  {
    name: "positions increase with every stored event, and reads return events in position order",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfOrder", [["k", id]], { i: 1 }), ev("ConfOrder", [["k", id]], { i: 2 })]);
      await append(h, [ev("ConfOrder", [["k", id]], { i: 3 })]);
      const { state } = await read(h, Query.forEventAndTag("ConfOrder", "k", id));
      assert.deepEqual(state.map((e) => (e.data as { i: number }).i), [1, 2, 3]);
      for (let i = 1; i < state.length; i++) assert.ok(state[i]!.position > state[i - 1]!.position);
    }
  },
  {
    name: "reading after a position excludes events at or before it; the final position is the newest matching event's",
    run: async (h) => {
      const id = uid();
      const q = Query.forEventAndTag("ConfAfter", "k", id);
      await append(h, [ev("ConfAfter", [["k", id]], { i: 1 })]);
      const first = await read(h, q);
      await append(h, [ev("ConfAfter", [["k", id]], { i: 2 })]);
      await append(h, [ev("ConfOther", [["k", id]], { i: 3 })]); // different type: not matched
      const later = await read(h, q, first.logPosition);
      assert.deepEqual(later.state.map((e) => (e.data as { i: number }).i), [2]);
      assert.ok(later.logPosition.position > first.logPosition.position);
      // nothing newer: the position stays where it was asked to start
      const none = await read(h, q, later.logPosition);
      assert.equal(none.state.length, 0);
      assert.equal(none.logPosition.position, later.logPosition.position);
    }
  },
  {
    name: "an item matches ANY of its event types but needs ALL of its tags",
    run: async (h) => {
      const id = uid();
      const a = `ConfTA${id}`;
      const b = `ConfTB${id}`;
      await append(h, [
        ev(a, [["k", id], ["j", "1"]]),
        ev(b, [["k", id], ["j", "1"]]),
        ev(a, [["k", id]]), // lacks tag j
        ev(`ConfTC${id}`, [["k", id], ["j", "1"]]) // other type
      ]);
      const { state } = await read(h, Query.of(item([a, b], [["k", id], ["j", "1"]])));
      assert.deepEqual(state.map((e) => e.type), [a, b]);
    }
  },
  {
    name: "items are OR-ed; an event mixing one item's type with ANOTHER item's tags matches neither",
    run: async (h) => {
      const id = uid();
      const a = `ConfMA${id}`;
      const b = `ConfMB${id}`;
      await append(h, [ev(a, [["k", id]]), ev(b, [["j", id]]), ev(a, [["j", id]])]); // third mixes a's type with b's tag
      const { state } = await read(h, Query.of([item([a], [["k", id]]), item([b], [["j", id]])]));
      assert.deepEqual(state.map((e) => e.type), [a, b]);
    }
  },
  {
    name: "an item with no types matches any type; a query with no informative items matches every event",
    run: async (h) => {
      const id = uid();
      const start = await headPosition(h);
      await append(h, [ev(`ConfWA${id}`, [["k", id]]), ev(`ConfWB${id}`, [["k", id]]), ev(`ConfWC${id}`, [["other", id]])]);
      const byTag = await read(h, Query.of(item([], [["k", id]])));
      assert.equal(byTag.state.length, 2);
      // no informative item (an empty item, or none at all): reading matches everything after `start`
      for (const q of [Query.of([]), Query.of(item([], []))]) {
        assert.equal((await read(h, q, start)).state.length, 3);
      }
    }
  },
  {
    name: "exists reports whether anything matches",
    run: async (h) => {
      const id = uid();
      const q = Query.forEventAndTag("ConfExists", "k", id);
      assert.equal(await existsQuery(h, q), false);
      await append(h, [ev("ConfExists", [["k", id]])]);
      assert.equal(await existsQuery(h, q), true);
    }
  },
  {
    name: "concurrency: an event matching the query NEWER than the position refuses the append, and nothing is stored",
    run: async (h) => {
      const id = uid();
      const q = Query.forEventAndTag("ConfC", "k", id);
      const p0 = await positionOf(h, q);
      await append(h, [ev("ConfC", [["k", id]])]); // the conflicting event
      assert.equal(await append(h, [ev("ConfAttempt", [["k", id]])], AppendCondition.of(p0, q)), "conflict");
      assert.equal(await existsQuery(h, Query.forEventAndTag("ConfAttempt", "k", id)), false);
    }
  },
  {
    name: "concurrency: no matching event after the position (or matching only AT/before it) -> accepted",
    run: async (h) => {
      const id = uid();
      const q = Query.forEventAndTag("ConfD", "k", id);
      await append(h, [ev("ConfD", [["k", id]])]);
      const p = await positionOf(h, q); // includes that event: it is AT the position, not after it
      assert.equal(await append(h, [ev("ConfAttempt", [["k", id]])], AppendCondition.of(p, q)), "ok");
      // a newer event that does NOT match the query does not conflict either
      await append(h, [ev("ConfNotMatching", [["k", id]])]);
      assert.equal(await append(h, [ev("ConfAttempt2", [["k", id]])], AppendCondition.of(p, q)), "ok");
    }
  },
  {
    name: "concurrency: a conflicting event matching only ONE of several items (either one) refuses",
    run: async (h) => {
      for (const which of [0, 1]) {
        const id = uid();
        const a = `ConfIA${id}`;
        const b = `ConfIB${id}`;
        const q = Query.of([item([a], [["k", id]]), item([b], [["j", id]])]);
        const p0 = await positionOf(h, q);
        await append(h, [which === 0 ? ev(a, [["k", id]]) : ev(b, [["j", id]])]);
        assert.equal(await append(h, [ev("ConfAttempt")], AppendCondition.of(p0, q)), "conflict", `item ${which}`);
      }
    }
  },
  {
    name: "concurrency: a condition whose query has no informative item performs no check",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfE", [["k", id]])]);
      for (const q of [Query.of([]), Query.of(item([], []))]) {
        assert.equal(await append(h, [ev("ConfAttempt", [["k", id]])], AppendCondition.of(LogPosition.zero(), q)), "ok");
      }
    }
  },
  {
    name: "idempotency: a matching existing event refuses with Duplicate, at ANY position",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfF", [["op", id]])]);
      const q = Query.forEventAndTag("ConfF", "op", id);
      assert.equal(await append(h, [ev("ConfF", [["op", id]])], AppendCondition.idempotentFromQuery(q)), "duplicate");
      // the position given for the (absent) concurrency check plays no part in the idempotency check
      const high = await headPosition(h);
      assert.equal(await append(h, [ev("ConfF", [["op", id]])], AppendCondition.of(high, Query.noCondition(), q)), "duplicate");
    }
  },
  {
    name: "idempotency: several items are OR-ed; no matching item -> accepted",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfG", [["op", id]])]);
      const hit = Query.of([item(["ConfG"], [["op", uid()]]), item(["ConfG"], [["op", id]])]);
      assert.equal(await append(h, [ev("ConfG", [["op", id]])], AppendCondition.idempotentFromQuery(hit)), "duplicate");
      const miss = Query.of([item(["ConfG"], [["op", uid()]]), item(["ConfG"], [["op", uid()]])]);
      assert.equal(await append(h, [ev("ConfG", [["op", uid()]])], AppendCondition.idempotentFromQuery(miss)), "ok");
    }
  },
  {
    name: "idempotency is checked BEFORE concurrency: when both would refuse, the answer is Duplicate",
    run: async (h) => {
      const id = uid();
      const p0 = await headPosition(h);
      await append(h, [ev("ConfH", [["k", id], ["op", id]])]); // matches BOTH queries below
      const both = AppendCondition.of(p0, Query.forEventAndTag("ConfH", "k", id), Query.forEventAndTag("ConfH", "op", id));
      assert.equal(await append(h, [ev("ConfAttempt")], both), "duplicate");
    }
  },
  {
    name: "a refused append stores NOTHING, even from a multi-event batch; an accepted batch stores all, in order",
    run: async (h) => {
      const id = uid();
      const q = Query.forEventAndTag("ConfI", "k", id);
      const p0 = await positionOf(h, q);
      await append(h, [ev("ConfI", [["k", id]])]);
      const batch = [ev("ConfBatch1", [["b", id]]), ev("ConfBatch2", [["b", id]])];
      assert.equal(await append(h, batch, AppendCondition.of(p0, q)), "conflict");
      assert.equal((await read(h, Query.of(item([], [["b", id]])))).state.length, 0);
      assert.equal(await append(h, batch), "ok");
      assert.deepEqual((await read(h, Query.of(item([], [["b", id]])))).state.map((e) => e.type), ["ConfBatch1", "ConfBatch2"]);
    }
  },
  {
    name: "appending no events at all is a defect, not a typed failure",
    run: async (h) => {
      const exit = await h.run(Effect.flatMap(EventStore, (es) => Effect.exit(es.append([]))));
      assert.ok(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason), "expected a Die");
    }
  },
  {
    name: "tags round-trip exactly: '=' and unicode in values, and an event with no tags",
    run: async (h) => {
      const id = uid();
      const tricky = "a=b_héllo_wörld";
      await append(h, [ev("ConfJ", [["k", id], ["v", tricky]]), ev("ConfJNoTags", [], { untagged: true })]);
      const { state } = await read(h, Query.forEventAndTag("ConfJ", "k", id));
      assert.deepEqual(tagStrings(state[0]!), [`k=${id}`, `v=${tricky}`].sort());
      assert.equal(await existsQuery(h, Query.forEventAndTag("ConfJ", "v", tricky)), true);
    }
  },
  {
    name: "tag values containing commas, quotes, braces, backslashes and spaces round-trip and can be queried",
    run: async (h) => {
      const id = uid();
      for (const value of ["a,b", 'say "hi"', "{curly}", "back\\slash", "with space", "it's", "  padded  "]) {
        await append(h, [ev("ConfK", [["k", id], ["v", value]])]);
        const { state } = await read(h, Query.forEventAndTags("ConfK", [Tag.of("k", id), Tag.of("v", value)]));
        assert.equal(state.length, 1, `value ${JSON.stringify(value)} should be found by its own tag`);
        assert.equal(state[0]!.tags.find((t) => t.key === "v")?.value, value);
      }
    }
  },
  {
    name: "event data round-trips as JSON: nesting, arrays, null, numbers, unicode",
    run: async (h) => {
      const id = uid();
      const data = { a: { b: [1, 2.5, -3, null, "x", true] }, empty: {}, list: [], s: "héllo ✓", n: null };
      await append(h, [ev("ConfL", [["k", id]], data)]);
      const { state } = await read(h, Query.forEventAndTag("ConfL", "k", id));
      assert.deepEqual(state[0]!.data, data);
    }
  }
];

