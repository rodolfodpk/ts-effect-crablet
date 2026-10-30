// The conformance suite: what ANY EventStore implementation must do. The same cases run against the
// in-memory store (test/conformance-in-memory.test.ts, Bun) and against real Postgres
// (test/integration/conformance-postgres.test.ts, Node + Testcontainers). Where they agree, the
// in-memory store is a faithful stand-in for decision-logic tests; where a case fails on only one,
// that implementation has a bug (or the spec in src/spec/Spec.ts is wrong).
//
// Framework-neutral on purpose: a case is a plain async function using node:assert. Cases share one
// store, so each isolates itself with unique tag values / event types (`unique()`).
import assert from "node:assert/strict";
import { Cause, Clock, Effect, Exit, Stream } from "effect";
import { EventStore, stream, type StoredEvent } from "../../src/EventStore.ts";
import * as Cursor from "../../src/Cursor.ts";
import { EventDecodingError, EventDecodingFailure } from "../../src/EventDecoding.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import { Duplicate } from "../../src/AppendErrors.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as CorrelationContext from "../../src/CorrelationContext.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import { append, ev, existsQuery, headPosition, item, positionOf, read, tagStrings, uid, type Harness } from "./ops.ts";

export type { Harness } from "./ops.ts";
export interface ConformanceCase {
  readonly name: string;
  readonly run: (h: Harness) => Promise<void>;
}

// The Duplicate an append is refused with (it fails the case if the append is accepted or refused otherwise).
const duplicateFrom = (h: Harness, events: ReadonlyArray<AppendEvent.AppendEvent>, condition: AppendCondition.AppendCondition) =>
  h.run(Effect.flatMap(EventStore, (es) => Effect.flip(es.append(events, condition)))).then((error) => {
    assert.ok(error instanceof Duplicate, `expected a Duplicate, got ${String(error)}`);
    return error;
  });

export const cases: ReadonlyArray<ConformanceCase> = [
  {
    name: "an append reports the position of its LAST event, and later appends report higher ones",
    run: async (h) => {
      const id = uid();
      const first = await h.run(
        Effect.flatMap(EventStore, (es) => es.append([ev("ConfPos", [["k", id]]), ev("ConfPos", [["k", id]]), ev("ConfPos", [["k", id]])]))
      );
      const { state } = await read(h, Query.forEventAndTag("ConfPos", "k", id));
      assert.equal(state.length, 3);
      assert.equal(first.lastPosition, state[2]!.position, "lastPosition is the third event's position");
      assert.equal(typeof first.transactionId, "string");

      const second = await h.run(Effect.flatMap(EventStore, (es) => es.append([ev("ConfPos", [["k", id]])])));
      assert.ok(second.lastPosition > first.lastPosition);
    }
  },
  {
    name: "an event's occurredAt is the Effect Clock's time at the append, so a test clock fixes it",
    run: async (h) => {
      const id = uid();
      const at = Date.parse("2031-02-03T04:05:06.789Z");
      const fixed = (base: Clock.Clock): Clock.Clock =>
        Object.assign(Object.create(base), { currentTimeMillisUnsafe: () => at, currentTimeMillis: Effect.succeed(at) });
      await h.run(
        Effect.flatMap(Clock.Clock, (base) =>
          Effect.provideService(Effect.flatMap(EventStore, (es) => es.append([ev("ConfClock", [["k", id]])])), Clock.Clock, fixed(base))
        )
      );
      const { state } = await read(h, Query.forEventAndTag("ConfClock", "k", id));
      assert.equal(state[0]!.occurredAt.getTime(), at);
    }
  },
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
    name: "an item with no types matches any type; a query with no items matches every event",
    run: async (h) => {
      const id = uid();
      const start = await headPosition(h);
      await append(h, [ev(`ConfWA${id}`, [["k", id]]), ev(`ConfWB${id}`, [["k", id]]), ev(`ConfWC${id}`, [["other", id]])]);
      const byTag = await read(h, Query.of(item([], [["k", id]])));
      assert.equal(byTag.state.length, 2);
      // no items: reading matches everything after `start`
      assert.equal((await read(h, Query.of([]), start)).state.length, 3);
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
    name: "exists agrees with reading: by type alone, by tag alone, with items OR-ed, and with no items",
    run: async (h) => {
      const id = uid();
      const a = `ConfXA${id}`;
      const b = `ConfXB${id}`;
      // nothing of these types or with this tag exists yet
      assert.equal(await existsQuery(h, Query.of(item([a], []))), false);
      assert.equal(await existsQuery(h, Query.of(item([], [["k", id]]))), false);
      await append(h, [ev(a, [["k", id]]), ev(b, [["j", id]])]);
      assert.equal(await existsQuery(h, Query.of(item([a], []))), true, "type only");
      assert.equal(await existsQuery(h, Query.of(item([], [["k", id]]))), true, "tag only");
      assert.equal(await existsQuery(h, Query.of(item([a], [["j", id]]))), false, "one item's type with another item's tag matches nothing");
      assert.equal(await existsQuery(h, Query.of([item([a], [["j", id]]), item([b], [["j", id]])])), true, "items are OR-ed");
      // reading a query with no items matches every event, and so does exists (the log has events now)
      assert.equal(await existsQuery(h, Query.of([])), true);
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
    name: "concurrency: a condition whose query has no items performs no check",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfE", [["k", id]])]);
      assert.equal(await append(h, [ev("ConfAttempt", [["k", id]])], AppendCondition.of(LogPosition.zero(), Query.of([]))), "ok");
    }
  },
  {
    name: "an item with neither types nor tags is refused, as a defect, in a read, exists, a concurrency and an idempotency condition (ADR-0049)",
    run: async (h) => {
      assert.throws(() => item([], []), /targets events by type and\/or tags/);
      const empty = Query.of([{ eventTypes: [], tags: [] }]); // built without queryItemOf
      const withOther = Query.of([item(["ConfX"]), { eventTypes: [], tags: [] }]);
      const isDefect = async (effect: Effect.Effect<unknown, unknown, EventStore>, what: string) => {
        const exit = await h.run(Effect.exit(effect));
        assert.ok(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason), `${what}: expected a defect`);
        assert.match(String(exit.cause.reasons.find(Cause.isDieReason)?.defect), /targets events by type and\/or tags/, what);
      };
      for (const q of [empty, withOther]) {
        await isDefect(Effect.flatMap(EventStore, (es) => es.project(q, LogPosition.zero(), [{ eventTypes: [], initialState: 0, transition: (n: number) => n }])), "read");
        await isDefect(Effect.flatMap(EventStore, (es) => es.exists(q)), "exists");
        await isDefect(Effect.flatMap(EventStore, (es) => es.findDuplicate(q)), "findDuplicate");
        await isDefect(Effect.flatMap(EventStore, (es) => es.append([ev("ConfEmptyItem")], AppendCondition.of(LogPosition.zero(), q))), "concurrency condition");
        await isDefect(Effect.flatMap(EventStore, (es) => es.append([ev("ConfEmptyItem")], AppendCondition.idempotentFromQuery(q))), "idempotency condition");
      }
      assert.equal(await existsQuery(h, Query.forEvent("ConfEmptyItem")), false, "nothing was appended");
    }
  },
  {
    name: "a tag key or value with any characters makes the round trip exactly, and is found by exactly itself (ADR-0049)",
    run: async (h) => {
      const id = uid();
      const pairs: ReadonlyArray<readonly [string, string]> = [["a=b", `c${id}`], ["50%", `v${id}`], ["%3d", `w${id}`], ["a=b=c", `x${id}`], ["product:123", `y${id}`], ["k", `x=y${id}`]];
      for (const [key, value] of pairs) {
        const type = `ConfTagChars${id}`;
        await append(h, [ev(type, [[key, value]], { key })]);
        const found = await read(h, Query.forEventAndTag(type, key, value));
        assert.equal(found.state.length, 1, `${key}=${value}: found by its own tag`);
        assert.deepEqual(found.state[0]!.tags.map((t) => [t.key, t.value]), [[key, value]], `${key}=${value}: read back as it was written`);
        assert.equal(await existsQuery(h, Query.forEventAndTag(type, key, value)), true, `${key}=${value}: exists`);
        // a condition on it sees it after the position before it
        assert.equal(await append(h, [ev(`ConfTagCharsAttempt${id}`)], AppendCondition.of(LogPosition.zero(), Query.forEventAndTag(type, key, value))), "conflict", `${key}=${value}: a condition`);
      }
      // the ambiguity a stored `a=b=c...` would have: the tag (a=b, c) is not the tag (a, b=c)
      assert.equal((await read(h, Query.forEventAndTag(`ConfTagChars${id}`, "a", `b=c${id}`))).state.length, 0);
    }
  },
  {
    name: "read: a page of the matching events in log order, resumed from its cursor without repeating or skipping one, until a page is not full (ADR-0050)",
    run: async (h) => {
      const id = uid();
      const q = Query.of(item([], [["r", id]]));
      await append(h, Array.from({ length: 5 }, (_, i) => ev(`ConfRead${i}`, [["r", id]], { i })));
      await append(h, [ev("ConfReadOther", [["other", id]])]);
      const page = (after?: Cursor.Cursor) => h.run(Effect.flatMap(EventStore, (es) => es.read(q, { limit: 2, ...(after === undefined ? {} : { after }) })));
      const pages = [await page()];
      while (pages[pages.length - 1]!.more) pages.push(await page(pages[pages.length - 1]!.cursor));
      assert.deepEqual(pages.map((p) => p.events.map((e) => (e.data as { i: number }).i)), [[0, 1], [2, 3], [4]]);
      assert.deepEqual(pages.map((p) => p.more), [true, true, false]);
      // nothing after the last page: the same cursor back
      const after = await page(pages[2]!.cursor);
      assert.deepEqual([after.events.length, after.cursor, after.more], [0, pages[2]!.cursor, false]);
      // a cursor kept as text resumes the same way
      assert.deepEqual((await page(Cursor.fromString(Cursor.toString(pages[0]!.cursor)))).events.map((e) => (e.data as { i: number }).i), [2, 3]);
      // the whole stream is every page together
      const streamed = await h.run(Stream.runCollect(stream(q, { batchSize: 2 })));
      assert.deepEqual(streamed.map((e) => (e.data as { i: number }).i), [0, 1, 2, 3, 4]);
    }
  },
  {
    name: "read: a query with no items and a page size that is not a whole number of at least 1 are refused, as defects (ADR-0050)",
    run: async (h) => {
      for (const [what, effect] of [
        ["no items", Effect.flatMap(EventStore, (es) => es.read(Query.of([])))],
        ["limit 0", Effect.flatMap(EventStore, (es) => es.read(Query.forEvent("X"), { limit: 0 }))],
        ["limit 1.5", Effect.flatMap(EventStore, (es) => es.read(Query.forEvent("X"), { limit: 1.5 }))]
      ] as const) {
        const exit = await h.run(Effect.exit(effect));
        assert.ok(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason), `${what}: expected a defect`);
      }
      assert.ok((await h.run(Effect.flatMap(EventStore, (es) => es.read(Query.all(), { limit: 1 })))).events.length <= 1, "Query.all() is read");
    }
  },
  {
    name: "Query.all() reads every event, and as a condition is a conflict with any event after the position, or any at all without one (ADR-0050)",
    run: async (h) => {
      const id = uid();
      const start = await headPosition(h);
      await append(h, [ev(`ConfAllA${id}`, [["k", id]]), ev(`ConfAllB${id}`)]);
      assert.equal((await read(h, Query.all(), start)).state.length, 2, "a read");
      assert.equal(await existsQuery(h, Query.all()), true, "exists");
      const head = await headPosition(h);
      assert.equal(await append(h, [ev(`ConfAllAttempt${id}`)], AppendCondition.of(head, Query.all())), "ok", "nothing after the head");
      assert.equal(await append(h, [ev(`ConfAllAttempt${id}`)], AppendCondition.of(head, Query.all())), "conflict", "the attempt above is after it");
      assert.equal(await append(h, [ev(`ConfAllAttempt${id}`)], AppendCondition.of(LogPosition.zero(), Query.all())), "conflict", "from the start: any event");
      assert.equal(await append(h, [ev(`ConfAllAttempt${id}`)], AppendCondition.idempotentFromQuery(Query.all())), "duplicate", "as an idempotency query: any event");
    }
  },
  {
    name: "a tag repeated on an event is stored once, in the order of its first appearance (ADR-0049)",
    run: async (h) => {
      const id = uid();
      await append(h, [AppendEvent.builder(`ConfRepeat${id}`).tag("k", "1").tag("k", "2").tag("k", "1").data({ n: 1 }).build()]);
      const found = await read(h, Query.forEventAndTag(`ConfRepeat${id}`, "k", "1"));
      assert.deepEqual(found.state[0]!.tags.map((t) => [t.key, t.value]), [["k", "1"], ["k", "2"]]);
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
    name: "a Duplicate names the newest matching event and each distinct request behind the matches; the query saw it, not the trigger backstop",
    run: async (h) => {
      const id = uid();
      const under = (fingerprint: string) => (events: ReadonlyArray<AppendEvent.AppendEvent>) =>
        h.run(CorrelationContext.withRequestFingerprint(fingerprint)(Effect.flatMap(EventStore, (es) => es.append(events))));
      await under("aa01")([ev("ConfDup", [["op", id]])]);
      await under("aa02")([ev("ConfDup", [["op", id]])]);
      const newest = await under("aa02")([ev("ConfDup", [["op", id]])]);
      const duplicate = await duplicateFrom(h, [ev("ConfDup", [["op", id]])], AppendCondition.idempotentFromQuery(Query.forEventAndTag("ConfDup", "op", id)));
      assert.deepEqual(duplicate.latest, { position: newest.lastPosition, transactionId: newest.transactionId });
      assert.deepEqual([...duplicate.requests].sort((a, b) => String(a.fingerprint).localeCompare(String(b.fingerprint))), [
        { fingerprint: "aa01", causationId: null },
        { fingerprint: "aa02", causationId: null }
      ]);
      assert.equal(duplicate.byTrigger, false);
    }
  },
  {
    name: "the same trigger appending the same request again is refused by the backstop, pointing at the earlier append's last event, even with a condition that checks nothing",
    run: async (h) => {
      const id = uid();
      const trigger = (await h.run(Effect.flatMap(EventStore, (es) => es.append([ev("ConfTrigger", [["t", id]])])))).lastPosition;
      const underTrigger = <A, E>(effect: Effect.Effect<A, E, EventStore>) =>
        CorrelationContext.withCausationId(trigger)(CorrelationContext.withRequestFingerprint(id)(effect));
      const first = await h.run(underTrigger(Effect.flatMap(EventStore, (es) => es.append([ev("ConfEmitted", [["t", id]]), ev("ConfEmitted2", [["t", id]])]))));
      const again = await h.run(underTrigger(Effect.flatMap(EventStore, (es) => Effect.flip(es.append([ev("ConfEmitted", [["t", id]]), ev("ConfEmitted2", [["t", id]])], AppendCondition.empty())))));
      assert.ok(again instanceof Duplicate, "refused with Duplicate");
      assert.equal(again.byTrigger, true);
      assert.deepEqual(again.latest, { position: first.lastPosition, transactionId: first.transactionId });
      assert.deepEqual(again.requests, [{ fingerprint: id, causationId: trigger }]);
      // Another request under the same trigger is a different emit: accepted.
      await h.run(CorrelationContext.withCausationId(trigger)(CorrelationContext.withRequestFingerprint(`ff${id}`)(Effect.flatMap(EventStore, (es) => es.append([ev("ConfEmitted", [["t", id]])])))));
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
    name: "projecting with no projector at all is a defect, not a typed failure",
    run: async (h) => {
      const exit = await h.run(Effect.flatMap(EventStore, (es) => Effect.exit(es.project(Query.of([]), LogPosition.zero(), []))));
      assert.ok(Exit.isFailure(exit), "expected a failure");
      const die = exit.cause.reasons.find(Cause.isDieReason);
      assert.equal(die?.defect, "At least one projector is required");
    }
  },
  {
    name: "each projector of a projection sees only its own event types (none listed: every type), in log order, over one state",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfProjA", [["p", id]]), ev("ConfProjB", [["p", id]]), ev("ConfProjA", [["p", id]])]);
      const projector = (name: string, eventTypes: ReadonlyArray<string>) => ({
        eventTypes,
        initialState: [] as ReadonlyArray<string>,
        transition: (seen: ReadonlyArray<string>, e: StoredEvent) => [...seen, `${name}:${e.type}`]
      });
      const { state } = await h.run(
        Effect.flatMap(EventStore, (es) => es.project(Query.of(item([], [["p", id]])), LogPosition.zero(), [projector("a", ["ConfProjA"]), projector("b", ["ConfProjB"]), projector("all", [])]))
      );
      assert.deepEqual(state, ["a:ConfProjA", "all:ConfProjA", "b:ConfProjB", "all:ConfProjB", "a:ConfProjA", "all:ConfProjA"]);
    }
  },
  {
    name: "an event the projector cannot read fails the projection with an EventDecodingError naming the event; it is never skipped",
    run: async (h) => {
      const id = uid();
      await append(h, [ev("ConfReadable", [["k", id]]), ev("ConfUnreadable", [["k", id]])]);
      const exit = await h.run(
        Effect.flatMap(EventStore, (es) =>
          Effect.exit(
            es.project(Query.of(item([], [["k", id]])), LogPosition.zero(), [
              {
                eventTypes: [],
                initialState: 0,
                transition: (n: number, e: StoredEvent) => {
                  if (e.type === "ConfUnreadable") throw new EventDecodingFailure(e.type, [{ path: ["amount"], message: "Missing key" }]);
                  return n + 1;
                }
              }
            ])
          )
        )
      );
      assert.ok(Exit.isFailure(exit), "the projection fails");
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      assert.ok(failure !== undefined && failure.error instanceof EventDecodingError, "with an EventDecodingError");
      const error = failure.error as EventDecodingError;
      assert.equal(error.type, "ConfUnreadable");
      assert.deepEqual(error.issues, [{ path: ["amount"], message: "Missing key" }]);
      assert.ok(error.position > 0n);
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

