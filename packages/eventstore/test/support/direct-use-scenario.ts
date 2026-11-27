// The guide's code, run against a store (in memory, or Postgres): one scenario both test files share.
import assert from "node:assert/strict";
import { Effect } from "effect";
import type { EventStore } from "../../src/EventStore.ts";
import { copiesBorrowedBy, CopyNotAvailable, lendAtTheDesk, lendCopy, lendCopyTyped, lendTwo, loanCount, loansOf, returnCopy } from "./direct-use.ts";

export const directUseScenario = (run: <A, E>(effect: Effect.Effect<A, E, EventStore>) => Promise<A>) => async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const [a, b, member] = [`a-${id}`, `b-${id}`, `m-${id}`];
  await run(lendCopy(a, member));
  const again = await run(Effect.flip(lendCopy(a, member)));
  assert.ok(again instanceof CopyNotAvailable, "a copy that is out cannot be lent");
  await run(returnCopy(a, member));
  await run(lendCopy(a, member));
  assert.strictEqual((await run(loansOf(member))).length, 2, "two loans, read page by page");
  assert.strictEqual(await run(loanCount(member)), 2, "and as a stream");
  // b then a (which is out): the transaction fails as a whole, and b's loan is not stored
  const failed = await run(Effect.flip(lendTwo(b, a, member)));
  assert.ok(failed instanceof CopyNotAvailable);
  assert.strictEqual((await run(loansOf(member))).length, 2, "the transaction rolled back b's loan");
  // a lend at the desk: the request's correlation and the metadata are on its event
  const request = crypto.randomUUID();
  const deskMember = `desk-${id}`;
  await run(lendAtTheDesk(`c-${id}`, deskMember, request));
  const [loan] = await run(loansOf(deskMember));
  assert.deepStrictEqual([loan!.correlationId, loan!.metadata], [request, { source: "front-desk" }]);
  // the typed lend reads and appends the same events as the untyped one
  const typedMember = `typed-${id}`;
  await run(lendCopyTyped(`t-${id}`, typedMember));
  assert.ok((await run(Effect.flip(lendCopyTyped(`t-${id}`, typedMember)))) instanceof CopyNotAvailable, "the typed lend refuses a copy that is out");
  assert.ok((await run(Effect.flip(lendCopy(`t-${id}`, typedMember)))) instanceof CopyNotAvailable, "and the untyped lend sees its loan");
  assert.deepStrictEqual(await run(copiesBorrowedBy(typedMember)), [`t-${id}`], "decoded through the schema");
};
