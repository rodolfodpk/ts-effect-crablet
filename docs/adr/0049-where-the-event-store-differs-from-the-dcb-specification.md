# ADR-0049: Where the event store differs from the DCB specification, and the guards it adds

## Status

**Accepted** (2026-10-29). Built: `Query.queryItemOf` and both stores refuse an item with neither types nor tags; `TagCodec` (the stored form of a
tag); a repeated tag stored once; `AppendCondition.firstWrite`; `EventStoreConfig.maxAppendEvents` (and `makeInMemoryEventStore({ maxAppendEvents })`).
The evaluation, requirement by requirement, is the [compatibility table](../concepts/dcb-guide.md#compatibility-with-the-specification) in the DCB
guide, against the specification at commit `ab2bc5a` of dcb-events.

## Context

A comparison of the event store with the DCB specification (`docs/specification.md` of dcb-events) found six places where they part:

1. A query that matches all events (`Query.all()`) and a read that can be limited or streamed: the store has neither; `project` folds every matching
   event in memory.
2. A query item with neither types nor tags was dropped: `[empty, X]` read only X, and in a condition it checked nothing. The specification has an
   item *"target Events by their Type and/or Tags"*; its example has items with only types and only tags, none with neither.
3. A tag is stored as the text `key=value` and read back by splitting at the first `=`, so `Tag.of("a=b", "c")` came back as `{ a, "b=c" }` and was
   found by a query for that other tag. The specification: a tag's form *"is irrelevant to the Event Store"*.
4. A repeated tag on an event was stored twice. The specification: tags *SHOULD* not contain the same tag twice.
5. An append is not refused for events its own transaction appended earlier (`crablet_items_match_any`). The specification: the append *MUST* fail
   if any event matches the condition.
6. An append takes at most 50 events. The specification: *MUST* provide a way to atomically persist one or more events.

## Decision

1. **The paged read and `Query.all()` are a change of their own**, planned after this one. Until then a query with no items reads every event, as
   before.
2. **An item with neither types nor tags is refused.** `Query.queryItemOf` throws; both stores refuse, as a defect, a query holding one built by hand
   (`Query.emptyItemIn`), in a read, `exists`, `findDuplicate` and either check of a condition. It is outside what the specification defines; giving
   it the meaning "every event" would duplicate `Query.all()` and, in a condition, take the global writer lock unseen. A query with no items keeps
   its meaning: no check in a condition, every event in a read.
3. **Any tag makes the round trip.** The stored text is the key with `%` encoded as `%25` and `=` as `%3D`, then `=`, then the value as it is
   (`TagCodec`). The first `=` is always the separator, and two different tags never share a stored text. A key with neither character, every key
   written before, is stored unchanged, so no migration: the SQL that splits a stored tag (`split_part(tag, '=', 1)`, the key table and the
   pollers' selection by key) gets the encoded key, which every query compares with, since every place that writes or reads the text goes through
   `TagCodec` (the event store's reads and conditions, the pollers' selections, `VerifyEvents`, `EventFixtures`). A database holding a key with a
   literal `%` written before this would no longer find it by that key; none of the repository's code or fixtures has one, and such a database is
   recreated (ADR-0047). The constructors keep lower-casing the key: that is the repository's convention, and the store writes what it is given.
4. **A repeated tag is stored once**, in the order of its first appearance, by both stores. The same key with different values stays (a list tag).
5. **The transaction's own appends stay exempt, and the exemption can be refused.** What the transaction wrote, it knows: without the exemption,
   writing, reading and writing again under a condition in one transaction would always fail. Removing it would not help commands, which never meet
   it (their append must be their transaction's first write, CRB01, ADR-0033), and the read's snapshot (ADR-0048) cannot tell the transaction's own
   events apart: on Postgres 18.6 a transaction's own xid is at or above its snapshot's xmax, so it is invisible even to a read made after its write.
   The risk the exemption leaves is a decision made on a read taken before the transaction's own write. `AppendCondition.firstWrite(condition)`
   asks the append to be its transaction's first write, the commands' rule, for code that uses the event store directly (no migration: the SQL
   parameter exists). It has no effect in the in-memory store, which has no transactions.
6. **The append limit is configurable**: `maxAppendEvents` (a whole number of at least 1, default 50, `DEFAULT_MAX_APPEND_EVENTS`;
   `MAX_APPEND_EVENTS` stays as its earlier name). One append is one transaction that holds the writer locks and sends one wake-up, so the default
   stays small; raising it is a choice of the application.

## Consequences

- Events the store wrote before stay readable: their keys have no `%` or `=` (an `=` in a key would have been misread anyway).
- Code that built an item with neither types nor tags now fails at once instead of reading or checking the wrong thing. None in the repository did;
  the differential test's generator gives such an item a type.
- The compatibility table in the DCB guide is the one place that says where the store stands; it names the specification's commit, to be
  reevaluated when that changes.
- Breaks (`scripts/breaks.ts`): `empty-item-accepted` (in place of `empty-condition-items-kept`), `first-write-ignored`, `tag-key-not-encoded`,
  `poller-key-not-encoded`, `tags-not-deduplicated`.
