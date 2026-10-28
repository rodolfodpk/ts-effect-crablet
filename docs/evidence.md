# Guarantees and evidence

*Evidence · anyone deciding whether to trust it · the [README](../README.md) read · 10 minutes*

What the framework guarantees, the test that checks each guarantee, what was measured, and the limits that are known. The table of numbers says what each number is and how
many runs it rests on; the full experiments, with what was wrong before each fix, are in the linked records.

## The guarantees, and what checks them

| Guarantee | What it means | Checked by |
|---|---|---|
| **No lost update within a boundary** | Two commands whose boundaries overlap cannot both decide on the same state; the second is refused and re-run on fresh state. | Race tests on Postgres that hold every racer at a barrier until all have loaded, so the overlap is forced, not hoped for: [`enrolment-guide-postgres.test.ts`](../packages/commands/test/integration/enrolment-guide-postgres.test.ts), [`transfer-guide-postgres.test.ts`](../packages/commands/test/integration/transfer-guide-postgres.test.ts), [`dcb-examples-postgres.test.ts`](../packages/commands/test/integration/dcb-examples-postgres.test.ts) |
| **No contention between disjoint boundaries** | Commands that share no events never conflict. | The same race tests, with retries turned off. |
| **The in-memory store behaves like Postgres** | Tests written with `given(...)` mean what they say. | One conformance suite, [`conformance/cases.ts`](../packages/eventstore/test/conformance/cases.ts), run against both stores. |
| **No event is skipped** | Every event a view, automation or publisher selects reaches it, even one committed late. | A transaction that commits out of order is forced in [`cursor-inversion.test.ts`](../packages/event-poller/test/integration/cursor-inversion.test.ts); concurrent writers in [`cursor-concurrent-writers.test.ts`](../packages/event-poller/test/integration/cursor-concurrent-writers.test.ts). The design is [ADR-0012](./adr/0012-transaction-position-cursors.md). |
| **A view applies a repeated batch once** | A crash or two leaders on one batch do not double a view's numbers. | [`view-exactly-once.test.ts`](../packages/views/test/integration/view-exactly-once.test.ts): the same batch twice, overlapping batches, and a crash before the cursor; each fails without its change and passes with it ([ADR-0023](./adr/0023-view-batch-and-cursor-in-one-transaction.md), [ADR-0032](./adr/0032-the-cursor-moves-only-from-where-its-batch-started.md)). |
| **One leader, fenced** | A process that lost its lock stops at its next check, before a batch or a cursor move; a batch already past the check is made safe by the cursor, which moves only from where the batch started. | The leader experiments in the reliability report (D1, D2), re-run after the fix; the kind lab; [`view-exactly-once.test.ts`](../packages/views/test/integration/view-exactly-once.test.ts) for two processors on one cursor ([ADR-0032](./adr/0032-the-cursor-moves-only-from-where-its-batch-started.md)). |
| **Reads are never silently stale** | A read with a marker includes the write, or answers `503`. | The read-consistency tests in `packages/views-http` and the wallet's end-to-end test. |
| **A stored event that no longer fits is never misread** | It fails with a typed `EventDecodingError` naming it, and is never skipped. | The event-evolution tests and experiment E7 ([ADR-0017](./adr/0017-event-evolution-by-compatibility.md)). |

**How good the tests are.** Line coverage of the packages (not the examples), merged from the unit and the integration suites, is gated in CI against a committed baseline (`scripts/coverage-gate.ts`, `coverage-baseline.json`): 99.7 % when the gate was set.
Coverage only says a line ran, so the correctness core was also broken by hand on purpose, 17 times: three breaks survived, and all three were real
gaps, now closed ([test coverage](./history/plans/test-coverage.md)). Mutation testing by a tool ([plan](./history/plans/mutation-testing.md)) covers the code the unit tests reach in `eventstore`, `commands` and `event-poller`: 92.0 % of its mutants are
killed, held by a ratchet that CI runs weekly (`scripts/mutation-gate.ts`); the database-bound code is not mutated by the tool yet.

## Numbers

**How they were measured.** On one laptop (8 cores) with Docker, against a real PostgreSQL 18 in a container, the application and the database on the same machine; the
failover rows on a local Kubernetes cluster (kind). Not a cloud database, not a production load. So the numbers compare one thing with another and give an order of
magnitude; they are not capacity. The last column says how many runs each rests on.

| What | Measured | How firm | Source |
|---|---|---|---|
| Loading 1,000,000 events through the append path | about **15,000 events/s** | two full runs that agreed in shape | reliability report, E9 |
| Size of an event with several tags, with its indexes and tag rows | about **1.2 KB** (wallet-shaped events, 1,203 bytes) | two full runs at 1,000,000 events | reliability report, E9 |
| What `event_id` adds | +6 B per event in the events heap, +0.4 % for the log (1,247 to 1,252 B/event); append rate unchanged | 200,000 wallet-shaped events, one run | `storage.diagnostic.ts` E9a, [ADR-0036](./adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md) |
| A transfer (`all` over two accounts) from an account with 100,000 events | **218 ms** (403 ms before the fix) | one experiment; the same harness timed 25 commands per size | reliability report, E5d |
| Takeover after a leader **crashes** | 0.2 to 4.2 s with the 5 s retry default: it is the retry interval minus the phase | six trials, one per phase of the retry cycle | reliability report, D1b |
| Takeover after a **graceful stop** | **0.04 to 0.10 s** (mean 0.07 s) | trials listed in the report | reliability report, D1c |
| Takeover when a leader **pod is killed** in Kubernetes | **0.4 s**; 0 of 52 acknowledged commands missing afterwards | one run | kind lab, `kill` |
| Takeover after a **silent network partition**, before the lock session's idle timeout | **13 to 29 s** with Postgres keepalives 10/5/3; **388 s** with the keepalives RDS ships | four runs (keepalives 10/5/3); one run (RDS keepalives) | kind lab, `partition-*` |
| Takeover after a silent partition, with the lock session's idle timeout (ADR-0045) | **3.04 s** with a 3 s timeout (the old leader stopped at 1.42 s); no takeover in 6 s without it | one run each, Postgres in a container, a proxy that cuts silently | `leader-partition.test.ts` |
| The same in Kubernetes, with the RDS keepalives (300/30/2) | **18 to 19 s** (18, 19, 18, 18, 19, 18 on a quiet host; 33 to 48 s while the host also ran test suites), against 388 s before; 0 acknowledged commands missing | six runs on a quiet host | kind lab, `partition-rds` |
| A pod cut off in the middle of a transaction | the views wait until the server ends its session: for as long as watched without `idle_in_transaction_session_timeout`, about 2 s with it at 2 s; the vanished append rolled back | integration test | `zombie-transaction.test.ts` |
| An attempt for the lock right after the shared lock session dies (ADR-0046) | **0** failed attempts in 40 rounds × 6 runs; without the guard, a failure in each of 3 runs, at rounds 0 to 5 | integration test, repeated | `leader-shared-session-race.test.ts` |
| A stale leader's handler calls after losing its session | **0** (723 before the fix) | one run, 40 s | reliability report, D1 |
| Acknowledged commands missing from the views | **0**: of 50 (rolling update), 52 (pod killed), 214 (long transaction), 283 (node lost); and in each partition run | one run each, except the partitions | kind lab |

The full records, with every experiment, what was wrong before each fix and how firm each number is:
[the reliability and scale report](./history/plans/reliability-and-scale-diagnostic.md) and [the kind lab](./history/plans/kind-lab.md).

## Known limits

- **One PostgreSQL database.** There is no sharding or partitioning of the log.
- **No retention.** Events are never deleted, and erasing personal data from the log is not built ([events over time](./concepts/events-over-time.md)).
- **A long write transaction delays every view** until it ends, because no event is delivered while an older transaction is still open. Monitor idle-in-transaction sessions.
- **A silent network partition is the slow failover case.** In the kind lab the lock was freed only when Postgres gave up on the connection, so the keepalive settings decided the delay. The lock session now ends itself on the server after the leader has been silent for 15 s ([ADR-0045](./adr/0045-a-leader-session-ends-itself-when-the-leader-goes-silent.md)); measured in an integration test and in the kind lab (18 to 19 s with the RDS keepalives on a quiet host, 388 s before).
- **Running out of connections is quiet.** In the kind lab a fifth of the commands failed and nothing in the pods said why. Keep pool size times replicas under `max_connections` ([size the pool](./guides/operate/run-in-production.md#size-the-pool)).
- **The start-up migration of the examples is not safe with several instances at once.** Use a migration job; Flyway passed the same race three times out of three (kind lab, `flyway-race`).
- **Not verified on a managed cloud database.** RDS Proxy and RDS-specific behaviour were not tested.
