# The kind lab (ADR-0022, arrangement C)

**Status:** built and run once through (2026-10-08). A scripted lab on a local Kubernetes cluster that runs the wallet as separate deployments (the API and the workers) against one Postgres and breaks them on purpose, one
scenario at a time, each starting from an empty database. It is a **baseline**: it measures what the code does today. It is not a proof that a production deployment behaves the same.

## What it is

- **Cluster:** kind v0.33.0, three nodes (Kubernetes 1.37.0): the control plane (Postgres runs there, so losing a worker node never takes the database with it) and two workers. Docker Desktop, 8 CPUs, 11.7 GiB, one laptop.
- **Deployments** (`examples/wallet-example-app/lab/manifests/`): Postgres 18.6 with no volume; the API (`WALLET_ROLES=api`, 2 replicas, pool 10); the workers (`WALLET_ROLES=views,automations,outbox`, 2 replicas, pool 10, rolling update with `maxSurge: 1, maxUnavailable: 0`). One image for every role
  (`examples/wallet-example-app/Dockerfile`: Bun installs, Node 24 runs the TypeScript). The schema is applied by a **pre-deploy Job**, never by the pods (`WALLET_MIGRATE=off`).
- **Load and checks:** commands through the API (`open_wallet`, 5 a second unless stated). Two checks in every scenario: **nothing acknowledged is lost** (every wallet the API answered 201 for must appear in `wallet_balance_view` afterwards) and the
  **lag of the balance view** (the age of the oldest `WalletOpened` event past its cursor, sampled every 250 ms).
- **Run it:** `node examples/wallet-example-app/lab/lab.ts up`, then `run <scenario>...` (no names runs all), then `down`. Needs Docker, kind and kubectl 1.30 or later.

## Watching it

`node examples/wallet-example-app/lab/lab.ts observe` brings up the cluster with Grafana, the wallet (2 API pods, 2 workers) and a load generator that sends, every 5 seconds, a uniformly random number of commands from 10 to 1000
(`scripts/load.ts --burst-every 5 --burst-min 10 --burst-max 1000 --wallets 200`: deposits, withdrawals and transfers, with a few that fail on purpose). It prints the addresses; they are:

| What | Where | Login |
|---|---|---|
| Grafana, the "Crablet" dashboard | http://localhost:3000 (Dashboards, "Crablet") | admin / admin |
| The processors admin page (Foldkit) | http://localhost:5173, after `cd examples/processors-admin-ui && ADMIN_API_URL=http://127.0.0.1:8081 bun run dev` | the token `lab-token` |
| The wallet API | http://localhost:8081 (`/openapi.json`, `/admin/processors` with `Authorization: Bearer lab-token`) | none |
| The list of wallets (JSON, in the browser) | http://localhost:8081/api/wallets (`?limit=50`, and `?after=<next>` for the next page); one wallet: `/api/wallets/<walletId>`, its `/transactions` and `/summary` | none |
| Postgres | localhost:5433, database `wallet_db` | postgres / postgres |
| The load | `kubectl --context kind-crablet-lab logs -f deploy/loadgen` | |

Use `127.0.0.1`, not `localhost`, for the admin page's proxy: `localhost` can resolve to IPv6 and the cluster publishes its ports on IPv4 only (the proxy then answers with nothing).
To see the failover on the dashboard and the admin page: `kubectl --context kind-crablet-lab delete pod -l role=workers --grace-period=0 --force`, or `rollout restart deployment/wallet-workers`. `lab.ts down` removes everything.

Checked on 2026-10-09: the dashboard is provisioned, the metrics arrive (events appended, commands, notifications sent, the consumers' status, leadership of the three modules, lag), and the admin page lists the six processors through its proxy.
Not checked: the dashboard's panels by eye (only that their metrics have data), the page in a browser, and the Grafana alerts firing. Under the first, lighter bursts (1 to 100 every 30 seconds) the API was slow (75 commands took 14 s, 61 took 31 s, longer than the interval) while the machine was also compiling something else; I did not look into it.

### The chaos page

[`examples/chaos-ui`](../../examples/chaos-ui/README.md) is a page to break the lab on purpose: choose the faults, run them for N minutes, then ask whether the data is still consistent. Start its server and the page as that README says; the page is at http://localhost:5175.
It also steers the load generator (interval, range, wallets, start and pause, with no restart) and can empty the database to start again.

What the lab, and that page, found while being built (2026-10-09):

- **The wallet's views lose updates.** The balance and summary views copy the `newBalance` recorded in the event; deposits are concurrent, so that number can be stale; 22 to 28 wallets of several hundred ended with a balance other than the sum of their events. The log was right. The fix is for the projectors to apply the amount.
- **Commands deadlock under concurrency.** Each wallet command makes more than one append in its transaction (opening the statement period, then the deposit or transfer); two transfers in opposite directions take the locks in opposite orders. Measured: about 7 deadlocks a second under bursts of up to 1000 commands, and a burst of 875 commands took 265 s
  with the machine idle. Postgres detects each cycle after `deadlock_timeout` (1 s). The load of 10 to 1000 commands every 5 seconds is therefore not sustainable on this wallet; a smaller range is.
- **A view keeps up at about `batchSize / pollingIntervalMs` events a second when it is behind**: after a full batch the processor waits for its interval instead of reading the next one (100 events a second with the wallet's settings), which is why a backlog drains slowly.
- **The metrics were wrong with more than one pod** until each instance exported with its own `service.instance.id` (a rate was 20 to 30 times too high).

## Results

One run of each unless a column says otherwise. "Lost" is acknowledged commands missing from the views after catching up.

| Scenario | What it does | Result | Lost |
|---|---|---|---|
| `rolling` | `kubectl rollout restart` of the workers under load | the rollout took 11 s; view lag stayed at 0.0 s | 0 of 50 |
| `kill` | the views leader pod is deleted with no grace period | another pod led the views after **0.4 s**; lag 0.0 s. A timeline (`trace-kill`) shows the new leader at 0.2 s and the cursor following the head of the log without a gap | 0 of 52 |
| `long-tx` | a transaction holds a transaction id for 30 s | the views waited: lag reached about 30 s during it and was back under 2 s **0.2 s after the commit** | 0 of 214 |
| `node-loss-tuned` | the node of the views leader is stopped | another pod led after **under 1 s**; lag 0.1 s; Kubernetes marked the node not ready after 53 s. 4 commands failed (the API pod on that node went with it) | 0 of 283 |
| `partition-tuned` | the leader loses the network to Postgres with a packet drop (no reset); Postgres keepalives 10/5/3 | takeover after **13, 28, 29 and 28 s** (four runs); lag followed the takeover time | 0 in every run |
| `partition-uto` | the same plus `tcp_user_timeout=15000` | takeover after **38, 18, 18 and 18 s** (four runs); lag followed the takeover time | 0 in every run |
| `partition-rds` | the same with the keepalives RDS sets (300/30/2) | takeover after **388 s** (keepalives allow about 360 s); 1821 commands acknowledged meanwhile | 0 |
| `migrate-race` | five pods run the start-up migration (apply to a fresh database) at once | **4 ok and 1 failed, then 0 and 5, then 3 and 2**; the errors were `relation "crablet_events" already exists`. The last run compared the schema with a single run's: identical (142 objects) | n/a |
| `flyway-race` | the same five pods, each running Flyway 13.10.0 | **5 of 5 succeeded in all three runs**; the schema was identical to a single run's (142 objects) and `flyway_schema_history` had 18 rows (13 of the framework, 5 of the wallet), none failed | n/a |
| `connections` | `max_connections=20` against four pods with a pool of 10 each, 10 commands a second | **83 and 85 of about 396 commands failed** (21 %), 18 to 19 connections open, **no pod restarted and no log line said the server was out of connections** | n/a |

## What it shows

1. **Failover works and loses nothing.** In every scenario that completed, every acknowledged command reached the views. A pod killed or a node lost hands over in under a second, because Postgres sees the connection close and frees the lock; a rolling update is invisible to the views.
2. **A silent partition is the slow case, and the Postgres keepalives set how slow.** With the leader unreachable and no reset, the lock is freed only when Postgres gives up on the connection: about 28 s with keepalives 10/5/3, **388 s with the settings RDS ships**. During that time the views do not move (the lag is the takeover time). This
   is the follow-up the ADR already names (a lease with a deadline in Postgres, so failover does not depend on the TCP stack). One of four tuned runs took 13 s and one first run, taken just after a node had been stopped and restarted, did not take over within 115 s and was not reproduced; its cause is unknown.
   Adding `tcp_user_timeout=15 s` took three of four runs to 18 s instead of 28 s (the fourth took 38 s): a modest gain, from a small sample.
3. **The start-up migration is a race, and Flyway closes it.** Our "apply to a fresh database" does not survive five pods at once, and what happens changes from run to run. Flyway with a history table and its lock did, three times out of three, on Postgres 18.6. The files already follow Flyway's naming (V1 to V13 for the framework, V100 and up for the application), so one image
   holds both in order; the range below 100 is the framework's. An existing database needs a baseline so Flyway accepts V1 to V104 as applied (not tried here).
4. **Running out of connections is quiet.** With the server out of slots, a fifth of the commands failed and nothing in the pods said why. I did not capture the error the API returned, so the cause of the failures is the one thing here inferred, not seen. Pool size times replicas must stay under `max_connections`
   ([the guide](../guides/run-in-production.md#size-the-pool)); this scenario is the evidence for it.
5. **A long write transaction stalls every view for as long as it lasts**, and they recover within a poll after it ends. Monitor idle-in-transaction sessions.

## What went wrong in the lab itself

- The first lag numbers were wrong. I measured the minimum cursor over the four views, but two of them read events the load never writes, so their cursors stay at 0 and the "lag" was the age of the log. The first batch's lags (15.6 s for the rolling update, 43 s for the long transaction, 59.9 s for the node loss) are not valid and
  were replaced; the takeover times and the loss checks were never affected.
- The Postgres readiness probe used the Unix socket, which answers during `initdb`, before the server listens on the network; the migration Job sometimes started too early. It uses TCP now.
- `kind load` of Postgres's multi-platform image fails with Docker Desktop's image store; the cluster pulls the public images itself and only the wallet and migration images are loaded.

## Not verified

- RDS Multi-AZ failover, RDS Proxy, a connection pooler of any kind, cross-AZ latency, managed-service behaviour. Everything above is a single Postgres in a container.
- `node-loss-rds` (the node loss with RDS keepalives) was interrupted and has no result.
- The outbox role and the automations were running but their own recovery was not measured, only the views'.
- Kubernetes' default pod-eviction timings were observed (a node was marked not ready after about 50 s) but the lab does not wait for the eviction of the pod.
- One to four runs of each scenario on a laptop under Docker, at 5 commands a second. Treat the numbers as orders of magnitude.
