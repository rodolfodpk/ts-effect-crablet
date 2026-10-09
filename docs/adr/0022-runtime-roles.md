# ADR-0022: One image, several runtime roles: the same code runs as one process or as separate deployments

## Status

**Proposed** (2026-10-08). Nothing is built. The facts below come from reading the code and from the measurements and AWS documentation cited in the context; no role split has been run. The decision is to be accepted when the tests in "Before accepting" exist and pass.

## Context

Everything runs in one process today. The wallet's entry point (`index.ts`) starts the three processor modules (`startBackgroundProcessors` returns the views, automations and outbox handles together), serves the HTTP API (the write commands and the read endpoints composed in one `HttpApi`), optionally mounts the admin API, and runs the metric samplers. That is right for development and tests and for a small deployment. It does not fit the deployment this project is being designed for: N web instances that scale with load, one active (and one standby) instance of each background module, on Kubernetes and RDS.

What the code and the measurements say about that shape:

- **Each module is already independent.** One advisory lock per module (`VIEWS_LOCK_KEY`, `AUTOMATIONS_LOCK_KEY`, `OUTBOX_LOCK_KEY`), one `LISTEN` on the events channel per module, its own cursors and fibers (ADR-0006, ADR-0007). A process may lead one module and not another. A deployment per module therefore matches the leader model without changing it.
- **Roles already talk only through Postgres.** Pollers wake by `NOTIFY` and read the log by cursor. A read that carries a marker waits for the view's progress through a table and a `NOTIFY` (the hub, ADR-0016), not through process memory, so it takes the same path in one process as in two. An automation executes its command **in its own process**, through the `CommandExecutor` against the same database (`AutomationsModule.ts`), never through the web API.
- **Status is in the database; the backoff is not.** `pause`, `resume` and `getStatus` go to the progress tracker (SQL). The backoff snapshot is in memory, in the process that runs the loop.
- **A web instance that scales with load must not carry leadership.** If it ran the processors, every scale-out would add a follower holding idle `LISTEN` connections, and a scale-in could remove the leader and force a failover for no reason.
- **A combined process holds a lot of its pool for good.** Measured on the wallet (Postgres 18.6, one idle instance): the leader held 7 of the default 10 connections (3 locks, 3 `LISTEN` for events, 1 for view progress) and a follower held 4 (the `LISTEN`s). Splitting by module does not add `LISTEN`s or locks (they are per module already); a process without the view-progress hub does not hold that one (by the code, not measured).
- **Failover on a partition depends on the network stack, not the framework** (measured in containers with the leader's network cut and no FIN/RST: the standby took over in 27 s with short TCP keepalives and in 365 s with the RDS defaults of 300/30/2). That is a separate decision (a lease with a deadline, or keepalive settings) and is **out of scope here**.
- **A connection pooler that multiplexes transactions cannot carry the held connections.** RDS Proxy pins the session on `LISTEN` and on session-level advisory locks, and does not pin on the transaction-level advisory locks the append uses ([AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html)). Separate roles make it possible to give the web role a pooled path and the workers direct connections; splitting the connection configuration inside one process is a separate piece of work.

## Decision

1. **A role is a set of capabilities chosen at start-up, by `WALLET_ROLES`.** A comma-separated list of `api`, `views`, `automations`, `outbox`, or `all`. Unset means `all`, which is today's behavior byte for byte. An unknown or empty entry stops the start-up with a message that names the variable and the value (the same rule as `WALLET_DB_POOL`).
   - `api`: the HTTP server (write commands, OpenAPI, read endpoints, the live feed) and the view-progress hub. **No processors**: no leader lock, no events `LISTEN`.
   - `views`, `automations`, `outbox`: only that module's processors and the sampler for them, plus a minimal health endpoint (decision 5). No application routes.
   - Any combination is allowed: `views,automations` is a "workers" deployment; `all` is the single process.
2. **Roles communicate only through Postgres.** This is a rule for new code, not just a description: no role may rely on another being in the same process (a shared `Ref`, an in-memory queue, a module-level singleton). Today's exceptions are listed in decision 4 and must be resolved, not extended.
3. **One image.** The Deployments differ by `WALLET_ROLES`, resources, replicas and probes. The domain code (events, models, commands, view projectors) is the same in all of them: an automation needs the command it executes, and the `api` role needs the same events to decode.
4. **Two things assume co-location and are resolved as part of this change:**
   - **The admin API** (`processors-http`) builds its sources from the processor handles in the process. An `api` pod has no running loops. The state it needs is in the database, so the handles may be constructible without starting them (creating one opens no connection and runs no loop); this is to be **verified** before relying on it. If it holds, the `api` role serves the admin API for all modules, with the backoff flag always false (it is local to the process that runs the loop; the response says so). If it does not, the admin API is served by the worker roles, one per module.
   - **The metric samplers** (`monitorProcessors`, `monitorStorage`) stay with the roles that have handles (the workers); in `all` they run as today.
5. **Workers get a health endpoint, not an API.** A minimal HTTP server with `/healthz` (the process is alive and its event loop answers) for the Kubernetes liveness probe. It does not report leadership: a standby is healthy.
6. **Migrations are not the roles' job.** In `all` the start-up keeps `migrateIfFresh` (development, tests). In the separate roles the schema is applied by a pre-deploy job (the example's `migrateIfFresh` is not safe when several instances start at once: they can all see an empty database).
7. **Kubernetes keeps the desired state; Postgres keeps the exclusion.** One Deployment per role. Replicas of a worker role give a warm standby, because the module lock stays the mutual exclusion (and what is meant to make a rolling update gap-free: the new pod waits as a follower, the old one releases the lock on SIGTERM; a graceful exit and the release were observed, the handover time was not measured and is a scenario of arrangement C). Delegating mutual exclusion to Kubernetes alone (replicas of 1, or a StatefulSet) was considered and rejected: it gives liveness, not exclusion, and loses the fence where the work happens.
8. **Out of the process model, deliberately.** The UI is a static bundle deployed on its own, not a role. Splitting the write API from the read API into two roles is **deferred** until write and read scale apart or read replicas are used. The outbox role is defined but not exercised until the outbox is brought in.

## Alternatives considered

- **A separate entry point (and image) per role.** Simple to read, but the roles drift, the single-process mode needs yet another entry point, and the domain code is duplicated in the build. Rejected for one entry point that reads the role.
- **Only two roles, `web` and `workers`.** Fewer Deployments, and a fine first step (`views,automations` in one). Not chosen as the design because the module locks are independent and the user-facing cost of a slow views module differs from that of a slow automation; the list syntax allows both.
- **A role per processor (a lock per view).** Would let views spread across pods. Out of scope: the locks are per module today, and that is a separate change with its own trade-offs.
- **Run everything as `all` and scale it.** Works (it is today's behavior with several replicas), and stays supported. It does not give the web tier an independent scale or keep leadership away from pods that autoscale.

## Consequences

- One codebase and one image cover the single-process and the distributed deployment, and anything between.
- More moving parts to operate (three or four Deployments, probes, alerts per role). The version skew between roles during a rollout is covered by the event-evolution rules (ADR-0017) and has to be respected by the deploy.
- The rule in decision 2 is a constraint on future features (for example, anything that wanted an in-memory shortcut between the API and a processor).
- The connection budget changes shape: web instances hold few connections for good, workers hold their module's lock and `LISTEN`. The pool-sizing guide already describes the arithmetic; the numbers per role are to be measured here.
- The admin API's behavior in the `api` role depends on the verification in decision 4.

## Before accepting

- **Arrangement A, unchanged:** the whole existing suite passes with the default role (`all`). The test harness (`startWalletAppForTest`) keeps starting everything.
- **Arrangement B, roles in one test process:** a new integration suite starts several instances in one process, each with its own connection pool and a different role (`api`, `views`, `automations`), and runs the main flows across them: a command through `api` appears in a view built by `views` and is read back with its marker; the automation fires on its own instance; pause, resume and reset through the admin API take effect. It also asserts the boundaries from `pg_stat_activity` and `pg_locks`: the `api` instance holds no leader lock and no events `LISTEN`; the `views` instance holds only the views lock; with two instances of a worker role, exactly one leads. This runs in CI without containers.
- **Arrangement C, a local Kubernetes cluster (kind):** a scripted lab with one scenario per risk, each with a pass criterion, **baseline first** (the current behavior, then the changes): rolling update of a worker without a gap; kill a pod; cut the leader's network (RDS-default keepalives against short ones); lose a node (measuring Kubernetes' own timings, which this ADR does not assume); the migration race with several pods; connection exhaustion with a low `max_connections`; a long write transaction stalling the pollers. It cannot reproduce RDS Multi-AZ failover, RDS Proxy, cross-AZ latency or managed services; those stay unverified until run on AWS.
- The decision 4 verification (handles built without being started), and a test that the admin API in the `api` role lists and acts on every module.
- A health endpoint test (alive while standby) and a test that an invalid `WALLET_ROLES` stops the start.

## Progress (2026-10-08)

Still **Proposed**. Built and passing: `WALLET_ROLES` in the wallet (decisions 1, 5 and the `api`-role part of 4), the default role `all` unchanged (arrangement A: the whole existing suite passes), and arrangement B (`test/integration/roles-e2e.test.ts`: four instances in one process, each with its own pool, named in `pg_stat_activity`).

- **Decision 4, verified:** the handles are built without being started. Building one creates a `Ref`, a `PubSub` and a queue and opens no connection; `stop` on one that never started is a no-op. The `api` instance serves the admin API for all six processors, with status read from the database, and a pause or resume through it acts on the loop running in another instance.
- **Boundaries, measured from `pg_locks` and `pg_stat_activity`:** the `api` instance holds no leader lock and no events `LISTEN`; of two `views` instances exactly one holds the views lock and both `LISTEN`; the `automations` instance holds only its own lock. Stopping the leading `views` instance moves the lock to the other and views keep being built.
- **Across instances:** a command through `api` is projected by `views` and read back from `api` with its marker, and without one; the automation fires on its own instance.
- **Not done:** the `outbox` role is not exercised in B; the migration-race handling of decision 6 (a pre-deploy job) is not built; arrangement C (kind) needs a Dockerfile.

## Follow-ups (not decided here)

- A lease with a deadline in Postgres, or a documented keepalive setting, so failover does not depend on the TCP stack (measured above).
- Fewer held connections per process: one `LISTEN` connection and one lock session per process instead of one per module.
- Separating the held connections from the work pool in the connection configuration, so the web role can use a pooler.
- Splitting the write API from the read API; a lock per processor.
