# ADR-0017: Events evolve by compatibility: a tolerant reader, and a new event for anything that is not

## Status

Accepted (2026-10-06), after the spike below showed the policy is implementable as written. Being built in the order given under "Implementation order"; each step is committed on its own and recorded in NOTES.md.

## Context

Events are never rewritten, so the log holds every shape an event has ever been written in. Today nothing in the framework says how a payload may change.

**What the code does (checked).**
- `defineEvent` builds `decode` with `Schema.decodeUnknownSync(schema)`. A stored payload that does not match throws. A model's fold decodes every event it handles (`Model.ts`), so a command over a boundary that contains one old-shape event fails with a **defect**, not a typed error, and fails again on every later attempt. Measured (docs/plans/reliability-and-scale-diagnostic.md, E7): one such event made every command on its boundary fail, an HTTP 500, with no indication of which event or type was the cause.
- Readers are inconsistent. Commands and the course app's projector decode through the event definition; the wallet's view projectors and its automation cast the raw payload (`event.data as WalletEvents.DepositMade`) and validate nothing, so an old-shape event there is not an error but a silently wrong view.
- Events carry no version. A row has a type, tags and a JSON payload.

**What DCB adds.** A model's boundary is built from the event types it handles (`.on(...)`) and the tags it binds by (`Model.ts`: one query item per binding, types any-of, tags all-of). So:
- an event type the model does not handle is not in its query: it is invisible to the fold **and to the conflict check**. Stopping handling an old type, or forgetting to handle a new one, silently shrinks the boundary and the protection with it. (In a stream-per-aggregate system an unknown event in a stream is at least present.)
- tags are computed from the payload when the event is written and stored; they are how boundaries find events. A change to what a tag means, or a new tag that old events lack, changes which events a boundary contains.

**What the talk says.** David Schmitz, "Event Sourcing - You are doing it wrong" (slides 94-108 of his deck, and the rule as summarized by the project owner): "a new version of an event must be constructible from the old version"; a new field needs a sensible default and the event stays the same; otherwise it is a **new event with a different name**. His team dropped traditional versioning, double-writes and upcasters because chains of them become unmaintainable ("Good luck maintaining that monster"), and prefers simple, human-readable JSON with a "weak schema" that describes and does not constrain. (An earlier draft of this thinking proposed upcasters; that was a misreading of a summary and is withdrawn.)

## Decision

1. **The compatibility rule.** A new shape of an event is allowed under the same name only if it is **constructible from every older shape**:
   - allowed in place: adding a field that is optional or has a documented default; fields the reader does not know are ignored;
   - not allowed in place: renaming or removing a field, changing a type or the meaning of a field, making a field required that old events lack, changing what a tag means.
   Anything else is a **new event type with a new name**, preferably a business name (`DepositReversed`) over a version suffix (`DepositMadeV2`). The old type stays in the log and in the code that reads it.
2. **No upcasters, no version column, no double-writes.** There is no version marker on an event and no chain of conversion functions. If a need appears that this rule cannot meet, it gets its own ADR.
3. **A tolerant reader, and a failure that names its cause.**
   - Event definitions express defaults, and every reader decodes through the definition: models (already), and view projectors, the outbox and automations (today some cast). A decoded payload is what a handler sees.
   - A stored event that cannot be decoded is reported as an `EventDecodingError` carrying the event's **position, transaction id, type and the schema issues**, never as an anonymous defect. It is counted by a metric and logged once per event. It is never skipped: a decision made over a partial boundary is worse than a refused one, so reading fails closed.
   - A default for a field marked `personal(...)` must not invent personal data (use absence, not a placeholder).
4. **Compatibility is checked, not hoped.**
   - *Fixtures.* Each event type keeps the payloads it has ever been written with as test fixtures, and a test asserts that the current definition decodes every one and derives the same tags from each.
   - *`verify-events`.* A script decodes stored events by type against the current definitions and reports the count decoded and the positions of failures per type. It is meant for CI against a copy of production data and for operators; it can sample by type and position range, because a full scan is proportional to the log (about 476 bytes per event on disk).
5. **DCB rule A: a model accounts for every type that can carry its tags.** `verify-events` also lists, for each model and each of its binding tag keys, the event types present in the log under that tag that the model neither handles nor declares as deliberately ignored; a non-empty list is a failure. This is the safety net for a "new name" policy, which by design makes the set of types per model grow.
6. **DCB rule B: tags are additive-only.** A tag key is never removed or given a new meaning. A new tag on a new event type is fine. A new tag on a new shape of an old type does not make the old events findable by it. Making them findable means rebuilding the tag index from the payloads (tags are a pure function of the payload, `tags: (d) => ...`, so it can be done without touching the facts), which updates stored rows and needs exclusive locks; it is an exceptional maintenance operation that needs its own decision and is not built here.
7. **Corrections are events.** Stored events are never updated; a mistake is corrected by a compensating event. (Restated because the whole policy depends on it.)

## Alternatives considered

- **A version on each event plus upcasters** (the common answer). Rejected: it adds a stored marker and a function chain that every consumer must run, the chain grows with every change, and it does nothing for tags. The talk's own experience is that it becomes unmaintainable.
- **A version column without upcasters.** Costs a column and a migration and buys nothing the rule above does not already give.
- **Rewriting old events when a shape changes.** Breaks immutability and the audit trail.
- **Keep strict decoding as it is.** One incompatible event then bricks its boundary (E7).
- **Skip events that fail to decode.** Rejected: it silently removes facts from decisions.

## Consequences

- **Old events keep working** with no migration of the log, and a breaking change is visible in the code as a new type that a model must `.on(...)`.
- **More event types over time**, and each model's handler list grows. DCB rule A makes forgetting one a failing check instead of a silent hole.
- **Every reader now decodes.** The wallet's projectors and automation change from casts to decoding through the definitions (additive for behavior, a real change in code).
- **The decode failure is a new, named error** (typed, in the `E` channel; over HTTP the generic 500 problem, with the event's position and type in the log line and the metric, not in the response), instead of a bare defect. A caller that catches `Conflict` and `SqlError` exhaustively now sees `EventDecodingError` in the union too (the wallet example's period resolver needed it added).
- **Discipline moves into tests and one script.** Fixtures must be kept when a shape changes, and `verify-events` needs a database with realistic data to be worth running.
- **Unchanged by this ADR:** crypto-shredding of personal data (it needs each personal field to say which data subject it belongs to, because an event can concern several subjects; separate decision), and rebuilding the tag index.

## Spike result (2026-10-06): the policy is implementable as written

Recorded as 17 tests in `packages/commands/test/event-evolution.test.ts`, against the pinned Effect 4.0.0 (`Schema.d.ts`). The two earlier failed attempts were my misuse (guessed names and signatures), not a limit of the library.

1. **How a default is written.** `Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))` inside a `Schema.Struct`. The key may be absent in the stored payload (not `null`, not wrong-typed: those are still errors); the decoded type has the field REQUIRED (`fee: number`), so code that reads events never handles a missing field, and a NEW event must be built with it (omitting it is a compile error, so the default serves old stored payloads only). Use a constant default (`Effect.succeed`): `defineEvent` decodes synchronously. For a field with no sensible default use `Schema.optionalKey(...)` (type `note?: string`; absent stays absent, nothing is invented). `personal(...)` is still found on both an optional and a defaulted field (`personalPaths`), so redaction and the audit still see it.
2. **A tolerant reader both ways.** Fields a reader does not know are ignored (Struct's default), so older code reads events written by newer code, and the old definition still decodes the new payload. What is stored is the event's data as written (`defineEvent` stores the decoded value, it does not re-encode), so `encodingStrategy` does not matter for storage.
3. **What a failure carries.** `defineEvent`'s `decode` throws a `SchemaError` with the issue tree. `SchemaIssue.makeFormatterStandardSchemaV1()` turns it into a flat list of `{ path, message }`, and `{ errors: "all" }` (a parse option) reports every problem instead of only the first. The default messages ("Expected number", "Missing key") do **not** echo the offending value, checked on a length check, a literal and a type mismatch with personal-looking values: so these issues are safe to log. Caution: a custom message or a filter that reports its input can echo it; `EventDecodingError` carries paths and messages, never the payload.
4. **Rule B (tags additive-only) is checkable.** A prototype of the fixture check (the payload an event type was once written with, plus the tags it was stored with): decode it with the current definition, derive its tags, and compare. A compatible change passes; a tag computed from a defaulted field is reported ("the definition now derives fee_class=free, which this stored event does not have, a boundary on it would miss the event"); a rename or a new required field is reported as an undecodable old payload.

## Open points for the implementation

1. ~~How a default is written~~ (resolved above).
2. **Where the typed failure is raised** (design, not built). `defineEvent.decode` would catch the `SchemaError` and throw a small `EventDecodingFailure` carrying the `{ path, message }` list (decoded with `errors: "all"`); `EventStore.project`'s loop (and the in-memory store's) catches it around `transition` and fails with a typed `EventDecodingError { position, transactionId, type, issues }`, because only the loop knows the event's metadata. The executor maps it to an HTTP 500 problem type naming position and type in logs. This keeps the fold synchronous and changes the failure from a defect to a typed error. To be built and tested against E7.
3. **`verify-events` at scale.** Sampling by type and by position range is the default; a full scan is opt-in.

## Implementation order

(Plan step 5 in docs/plans/reliability-and-scale-diagnostic.md.) 1. ~~`EventDecodingError`, its metric, its mapping in the executor; E7 then fails with the named error.~~ (done: `defineEvent.decode` throws an `EventDecodingFailure` with every problem as `{ path, message }`; `EventStore.project` (and the in-memory store) turns it into a typed `EventDecodingError { type, position, transactionId, issues }`, logs it once with `Effect.logError` and counts `crablet.eventstore.decoding_failures` by event type; `Model.load` and the commands' error channel carry it; `commands-http` presents it as the generic 500 without naming the event. E7 re-run: the command fails with `EventDecodingError` naming Ticked at position 4, transaction 765, issue `Missing key at entityId`, and again on the second attempt, instead of a defect. Tests: unit 549, real Postgres through the executor, and over HTTP; mutation-checked.) 2. ~~Decode through the definitions in every reader (the wallet's projectors and automation).~~ (done: every event definition has `decodeStored(event)`, an Effect that fails with the typed `EventDecodingError` and logs and counts it once, shared with `project`; the wallet's four view projectors and its automation, and the course app's projector, now read through it instead of casting `event.data` or calling the throwing `decode`, so an unreadable event is recorded against the view or automation (and after `maxErrors` marks it FAILED) instead of being projected wrong or becoming an unrecorded defect. A view batch with an unreadable event is rolled back whole. Tests: unit for `decodeStored`, real Postgres for the three wallet views (a good event in the same batch is rolled back with it), the automation; mutation-checked. The tutorial's projector snippet was updated; its sync test passes.) 3. ~~The fixtures helper and the first fixtures.~~ (done: `@crablet/commands/testing/EventFixtures`: `checkEventFixtures`, `assertEventFixtures` (optionally `requireCoverage`), `fixtureOf` (capture a payload and its stored tags from an event), `loadEventFixtures` (a directory of JSON). A fixture is `{ type, payload, tags: ["k=v"], scopeTags?, note? }`; `scopeTags` are the keys of tags added with `extraTags` (a period, say), which may be stored without being derived. It reports `no_definition` (an event type the log holds but the code no longer defines), `undecodable` (with paths), `invented_tag` (derived now, not stored then: DCB rule B), `lost_tag`, `cannot_build`, and the event types with no fixture. The first fixtures are the wallet's eight event types and the course's two, captured from today's definitions, with the period tags as scope tags: they protect against FUTURE incompatible changes, not past ones (nothing older is known). Mutation-checked: renaming `newBalance` in `DepositMade` fails the wallet test naming the missing key.) 4. `verify-events`. 5. The DCB rule A check. 6. A note in the tutorial and the README. Each step ends green and is committed on its own.
