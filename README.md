# ts-effect-crablet

![CI](https://github.com/rodolfodpk/ts-effect-crablet/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/rodolfodpk/ts-effect-crablet/branch/main/graph/badge.svg)](https://codecov.io/gh/rodolfodpk/ts-effect-crablet)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![Effect](https://img.shields.io/badge/Effect-4.0%20RC-DE3163)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)

TypeScript/Effect port of [spring-crablet](https://github.com/rodolfodpk/spring-crablet) — a
Java 25/Spring Boot event-sourcing framework built on DCB-style consistency boundaries.

This is a **parallel implementation, not a replacement**: both the Java and TypeScript versions
are intended to be maintained long-term as separate products, not a migration path off Java.

## Packages

| Package | What it is |
|---|---|
| `packages/db-migrations` | Consolidated Flyway-style SQL migrations, shared as a plain file bundle |
| `packages/test-support` | Testcontainers-backed Postgres bootstrap for integration tests |
| `packages/eventstore` | Core event store: DCB append, tag-based queries, LISTEN/NOTIFY, advisory-lock leader election |
| `packages/commands` | Command handler framework built on `eventstore` (`CommandDecision`, `CommandExecutor`) |
| `packages/event-poller` | Generic polling engine (progress tracking, backoff, leader-gated fibers) — the shared base the views, outbox, and automations modules build on |
| `packages/views` | Read-model projections: `ViewProjector`s driven by the poller, with subscription and management services |
| `packages/outbox` | Transactional outbox: per-topic publishers fed from the event stream by the poller |
| `packages/automations` | Event-driven automations: react to events by deciding and issuing follow-up commands |
| `packages/commands-http` | Generic REST command API over `CommandExecutor`, with RFC 7807 problem-detail error responses |
| `packages/metrics-otel` | OpenTelemetry metrics vocabulary (command, event store, poller, leader, view, outbox, automation), wired into the consumer modules |
| `examples/wallet-example-app` | End-to-end example: wallet commands, views, an automation, an outbox, and HTTP composed together |

## Build & test

Requires Node 24+ (see `.nvmrc`) and Bun 1.4+.

```bash
bun install
bun run typecheck          # tsc --noEmit across the whole workspace
bun run test:unit          # fast, in-memory tests - runs under Bun
bun run test:unit:coverage # same suite, with an lcov report at coverage/lcov.info
bun run test:integration   # real Postgres via Testcontainers - runs under Node (see NOTES.md for why)
```

The coverage badge only covers the fast Bun unit suite, not the Postgres-backed integration
tests — merging coverage across two different test runners wasn't worth the added CI complexity
for this repo's size.

## Notes

[`NOTES.md`](./NOTES.md) is a running log of findings, gotchas, and phase-by-phase status —
start there for the "why," not just the "what." Lasting architectural decisions are extracted
into standalone ADRs under [`docs/adr/`](./docs/adr/README.md).
