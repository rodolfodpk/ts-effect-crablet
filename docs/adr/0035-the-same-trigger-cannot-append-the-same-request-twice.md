# ADR-0035: The same trigger cannot append the same request twice

## Status

**Accepted** (2026-10-18). Built: migration `V17__crablet_automation_emit_key.sql` (`crablet_events.emit_key`, the unique index
`idx_crablet_events_emit_key` on `(causation_id, emit_key)`), `Duplicate.byTrigger`, the reason `ALREADY_DONE_FOR_TRIGGER`, the same rule in the in-memory event
store, and `trigger-backstop-postgres.test.ts`. Builds on [ADR-0034](0034-a-repeat-must-be-the-same-request.md) (the request fingerprint); adds a database
guarantee next to [ADR-0023](0023-view-batch-and-cursor-in-one-transaction.md)'s "automations keep `idempotentBy`".

## Context

An automation's batch can be delivered twice: a crash between the commands and the cursor, or a zombie leader and its successor. Its commands are protected only by
`idempotentBy`, a query the author writes. A query that never matches what the command appends (a misspelled tag, the wrong event type) does nothing, and the work
happens twice. `assertAutomationIdempotent` finds that in a test, if the author calls it. Nothing found it in production.

ADR-0023 tried recording what each automation did per trigger, in a table written in the decision's transaction. It worked, but cost +26 % per decision. And with
`idempotentBy` deciding first, it only added protection against a key that is too narrow.

## Decision

An append made **under a cause** (an automation's trigger: `CorrelationContext.causationId`) stores an **emit key** on each of its events: the request's fingerprint
(ADR-0034) and the event's place in the append, `"<fingerprint hex>/<n>"`. The key is unique per cause (a partial unique index). A second append of the same request
for the same trigger hits the index:

- `append_events_if` catches the violation on that index (a subtransaction, only for appends under a cause) and reports a duplicate with `by_trigger`, pointing at
  the earlier event. Two deliveries racing: the second waits for the first's commit, then hits the index;
- the executor answers "already done" with the reason `ALREADY_DONE_FOR_TRIGGER` and the earlier write's marker, and logs a warning that names the command: its
  `idempotentBy` did not recognise its own repeat;
- the in-memory event store applies the same rule, and `checkAutomationIdempotency` reports a repeat that only the backstop caught as **NOT IDEMPOTENT**.

**Keyed by content, not by the decision's place.** A key built from the decision's index would be wrong. If `decide` returned `[A]` on the first delivery and
`[B, A]` on the second (it read state that changed), B would take A's slot and be dropped, where without the backstop it would have run. With the request's
content as the key, B is new and runs, and A is recognised.

`idempotentBy` stays required for an automation's command: it is the domain's key (one welcome per wallet, across triggers), which the backstop cannot know.

## Consequences

- A too-narrow key costs a warning, not wrong data. With ADR-0034's mismatch rule, a too-broad key is refused loudly instead of dropping work.
- Cost: an emit key on the events of automations' appends (about 70 bytes each), one more index entry for those events only (partial index), and a subtransaction
  around those appends. Requests from outside (HTTP) have no cause and pay nothing.
- What it cannot catch: a redelivery that builds a *different* request (the automation's input came from state that changed). That case is `idempotentBy`'s
  together with ADR-0034's rule (the same cause is "already done"). The guide says to build the input from the trigger.
- An automation that deliberately issues the identical request twice for one trigger gets it applied once.

## Alternatives considered

- **A record table per (automation, trigger)** (ADR-0023's spike): it works, at +26 % per decision.
- **Key by the decision's index**: rejected for the `[A]` then `[B, A]` drop above.
- **A check before the append instead of a unique index**: it races; the index is what makes two concurrent deliveries safe.
