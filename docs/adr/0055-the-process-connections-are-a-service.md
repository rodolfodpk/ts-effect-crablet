# ADR-0055: The connections a process holds are a service, closed with its layer

## Status

**Accepted** (2026-11-26, the maintainer's decision on violation V6, option (c), in the `@crablet/app` plan). Built: `@crablet/eventstore/ProcessConnections`
(`ProcessConnections`, `ProcessConnectionsLive`), provided by `Crablet.layer`. Tests: `packages/eventstore/test/integration/process-connections.test.ts`,
`packages/*/test/processor-requirements.types.ts`, `packages/app/test/processors.types.ts`. Amends [ADR-0046](0046-one-lock-session-per-process.md).

## Context

ADR-0046 gave a process one lock session (every leader of one client and one set of options takes its lock on one connection) and one `LISTEN`
connection per client. Both were kept in module-level `WeakMap`s keyed by the client: `sessionsByClient` in `Leader.ts` and `byClient` in
`SharedListen.ts`. It worked, and two pools stayed apart because the key was the client, but the state was outside the layer graph:

- no type said that something per process existed, so nothing showed which code shares it;
- the lifetime of two connections was set by whoever opened them first and closed them last, not by the layers, so "close the modules before the pool"
  was a rule in comments (ADR-0054 made it a layer order for the modules, not for these connections);
- a test or a second runtime in one process could not have its own, nor see them.

A third `WeakMap`, `checked` in `ServerSettings.ts`, only remembers that the `idle_in_transaction_session_timeout` warning was given for a client: it
holds no resource.

## Decision

1. **The lock sessions and the LISTEN connections are one service, `ProcessConnections`** (`leaders`, `listens`), built by `ProcessConnectionsLive`
   and provided by `Crablet.layer`, after the pool and before everything built on it. One service, not two: they are the two halves of ADR-0046, the
   connections a process holds for good beside its pool, and change for the same reasons.
2. **Its requirement is in the types.** `tryAcquireGlobalLeader`, `sharedListen` and `wakeupStream` need `ProcessConnections`; the engine carries the
   leader attempt's requirement like the handler's and the wake-up stream's (`acquireLeader: Effect<…, R>`), so each module's `*RunRequirements` and the
   requirements of `Crablet.processors` include it, derived and pinned by the type tests. Building a module (`make*`, `Crablet.catalog`) still needs only
   the SQL client: a catalog leads nothing and listens to nothing. `ViewProgressHubLive` needs it too.
3. **Closing the layer closes them.** Normally every leader released its lock and every listen ended before (the processors and the hub are built on the
   layer, so they close first) and there is nothing left. A session still open has its locks given back (`pg_advisory_unlock_all`, its lease reset) and
   then its connection; an open LISTEN connection is closed. A session-level lock belongs to the session, so giving the connection back to the pool
   without the unlock would keep it held: the test found that.
4. **Inside the service the sessions are still keyed by client and options**, as before: the leader of a module may use the session clients
   (ADR-0024) and the hub the application's, in one process.
5. **`checked` stays a module-level `WeakMap`.** It is a memo of a warning already given, with nothing to close; making it a service would put a
   requirement in every module's types for no guarantee.

## Consequences

- A test or a diagnostic that builds its own layers adds `ProcessConnectionsLive` (about thirty did). Each runtime gets its own connections, which is
  what a separate process has: the tests that model two processes in one Node process are now exact.
- Breaking, before release (ADR-0013): code that called `tryAcquireGlobalLeader`, `sharedListen` or `wakeupStream` without `Crablet.layer` provides
  `ProcessConnectionsLive`. The applications use `Crablet.layer` and need no change.
- Two `Crablet.layer`s in one context would give two services; one product per context (ADR-0054) already rules that out.
