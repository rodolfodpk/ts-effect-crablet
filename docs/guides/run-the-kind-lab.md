# Run the kind lab

Run the wallet as separate deployments on a local Kubernetes cluster, watch it on a Grafana dashboard and a Processors page, and break it on purpose from the chaos page. This is a **lab**: it measures and demonstrates; it is not how you deploy to production
([Run it in production](run-in-production.md) is). What it showed the first time is in [the lab record](../plans/kind-lab.md).

[← Task guides](README.md)

## 1. What you need

| | Used here | Why |
|---|---|---|
| Docker | Docker Desktop 29, 8 CPUs and 11.7 GiB given to it | kind runs the cluster in containers; the lab starts three nodes, Postgres, Grafana and the wallet. The least memory that works was not measured |
| kind | 0.33 | the cluster |
| kubectl | 1.37 (1.30 or later) | `kubectl debug --profile=netadmin` is how a network cut is made |
| Node | 24 or later (`.nvmrc`) | runs the lab script, the servers and the app's TypeScript |
| Bun | 1.4 | installs the dependencies and serves the two pages |

From the repository root, once: `bun install`.

Keep the machine otherwise quiet. A heavy build running beside the lab (a Homebrew compile, in one run) made every number worse and showed up as saturation that was not the system's.

## 2. Start the cluster

```bash
node examples/wallet-example-app/lab/lab.ts observe
```

It creates the three-node cluster (`crablet-lab`), builds the wallet image and the migrations image, loads them, and deploys Grafana, Postgres, the schema job, two API pods, two worker pods and a load generator. The first run takes several minutes (the images build and the
Grafana image is downloaded); it prints the addresses when it is done. `BUILD=0` reuses the images already built.

| What | Where |
|---|---|
| Grafana | http://localhost:3000 (admin / admin) |
| The wallet API | http://localhost:8081 (for example `/api/wallets`, `/openapi.json`) |
| Postgres | localhost:5433, database `wallet_db`, user and password `postgres` |

What the script accepts (the same lines are at the top of `examples/wallet-example-app/lab/lab.ts`):

<!-- file: examples/wallet-example-app/lab/lab.ts#usage -->
```ts
//   node examples/wallet-example-app/lab/lab.ts up             create the cluster (3 nodes), build and load the image
//   node examples/wallet-example-app/lab/lab.ts run <name>...  run scenarios (each starts from an empty database and a fresh deployment); no names = all
//   node examples/wallet-example-app/lab/lab.ts observe       up, then a deployment you can watch: Grafana, a load of 10 to 1000 commands every 5 s, the admin API (prints the addresses)
//   node examples/wallet-example-app/lab/lab.ts down           delete the cluster
// Needs Docker, kind and kubectl (1.30 or later: `kubectl debug --profile=netadmin`). BUILD=0 reuses the image already built.
```

The load generator starts at once, at its default: **every 5 seconds, 10 to 1000 commands**. On this wallet that is more than it can take (see "Know before you start"); the first thing to do is lower it (step 4).

## 3. Open the pages

The two pages are not in the cluster: they run on your computer and the server behind the chaos page runs `kubectl`. Use one terminal each, from the repository root.

```bash
node examples/chaos-ui/server/server.ts                                                          # the chaos lab's server, on 127.0.0.1:5174
cd examples/chaos-ui && bun run dev                                                              # the chaos page: http://localhost:5175
cd examples/processors-admin-ui && ADMIN_API_URL=http://127.0.0.1:8081 bun run dev               # the Processors page: http://localhost:5173
```

- **Chaos page**, http://localhost:5175: who leads each module, the load generator, the pods, the faults to run, a check that the data is consistent, and a reset. It links to the other two pages.
- **Processors page**, http://localhost:5173: type the token `lab-token`, Connect. The status, cursor and backlog of each processor, with Pause, Resume and Reset.
- **Grafana dashboard**: the link on the chaos page opens it on the last 15 minutes with a 5 s refresh. By hand: Dashboards, folder Crablet, dashboard Crablet.
  Set the variable "A gauge is stale after (s)" to **20** (the link does): the lab exports every 5 s, and a killed pod's old values then drop out in 20 seconds instead of two minutes.
- **The wallets**, http://localhost:8081/api/wallets: JSON, 20 a page (`?limit=100`, and `?after=` the `next` of the last page).

Use `127.0.0.1`, not `localhost`, in `ADMIN_API_URL`: the cluster publishes its ports on IPv4 only and `localhost` can resolve to IPv6.

## 4. A first test, about five minutes

1. On the chaos page, **Load**: set "Most commands" to **100** and press *Apply settings*. It changes while the generator runs; nothing restarts.
2. **Chaos run**: tick *Kill the views leader* and *Kill a worker*; run for **2** minutes, a fault every **20** seconds; leave *Verify the data when the run ends* ticked. *Start the run*.
3. Watch. The banner says what is wrong (nobody leads a module, a pod is not ready, a processor is behind). The leader cards show "took over N s ago". *What happened* lists each fault, in red, and what undid it, in green, with how long another pod took to lead (a killed
   leader is taken over in under a second, in the runs so far). On the Grafana dashboard each fault is a red vertical mark, and the timeline *Who led what, over time* shows the handover.
4. When the run ends it verifies: it pauses the load, waits for every processor to catch up, and compares the event log with what was built from it (balances, summary, overdrafts, duplicates, welcome notifications, the audit, one leader per module). Failures are listed first.
   A healthy run ends with *Everything that must hold, holds.*
5. To start again from nothing: *Clear the database* (it asks first). It empties the log, the commands, the views and the progress, and the load opens new wallets.

The faults, in the order of the page: kill the leader of the views, the automations or the outbox module; kill a worker or an API pod; a rolling update of the workers; cut the views leader from Postgres (packets dropped for the hold time, then healed: the slow
failover, 13 to 38 seconds with tuned keepalives and 388 with the settings RDS ships, as measured); pause a view. You choose which are in a run: each fault is one of the chosen ones, at random.

## 5. Know before you start

- **The default load saturates.** Commands that make more than one append in their transaction (opening the statement period, then the deposit or transfer) can deadlock under concurrency: about 7 a second were measured under bursts of up to 1000 commands, and one burst of 875 took
  265 seconds on an idle machine. Symptoms: the API pods answer slowly, the Processors page stays on "Loading processors..." until the answer arrives (it has no time limit), a verification waits a long time for the last burst. Start at 100 commands a burst.
- **Views can fall behind under load.** A view that is behind reads about `batchSize / pollingIntervalMs` events a second (100 with the wallet's settings): a backlog drains slowly.
- **Postgres has no volume.** Deleting its pod, or restarting its deployment, empties the database. The chaos page does not offer to kill it.
- **Grafana has no volume either.** Restarting it (the lab does when the dashboard changes) erases the history; the marks of earlier faults go with it.
- **Metrics from several pods** are told apart by `service.instance.id` (the pod name). Without it two pods write the same series and rates come out 20 to 30 times too high.
- **The scripted scenarios** are the same experiments without the pages: `node examples/wallet-example-app/lab/lab.ts run kill` (or `rolling`, `long-tx`, `partition-tuned`, `partition-uto`, `partition-rds`, `node-loss-tuned`, `migrate-race`, `flyway-race`, `connections`, `trace-kill`).
  Each starts from an empty database; with no names it runs them all, which takes a long time (the RDS ones wait six minutes each). `lab.ts` with no arguments lists them.

## 6. When something does not work

| You see | Because | Do |
|---|---|---|
| "The lab server is not reachable" on the chaos page | the server on :5174 is not running | `node examples/chaos-ui/server/server.ts` |
| Processors page on "Loading processors..." | the wallet API is saturated, or the cluster is down | `curl -m 5 -H 'Authorization: Bearer lab-token' localhost:8081/admin/processors`; lower the load |
| An empty page on :5173 or :5175 after the cluster was deleted | the pages outlive the cluster | start the cluster again |
| `kind load` fails with "content digest ... not found" | Docker Desktop's image store and a multi-platform image | the lab loads only its own images; public ones are pulled by the cluster |
| "Paused processors" is 1 and the status table lists a view twice | a killed pod's last value (Prometheus keeps it for a few minutes) | lower "A gauge is stale after (s)" |
| A pod stays `Pending` after you edit the manifests | the API pods are one per node (required anti-affinity) and the rolling update needs room | the API deployment replaces one pod at a time; do not add a surge |

## 7. Stop

Press Ctrl+C in each terminal that runs a server, then:

```bash
node examples/wallet-example-app/lab/lab.ts down                      # deletes the cluster (the database and Grafana's history go with it)
docker image rm crablet-wallet:lab crablet-migrations:lab             # optional: the images the lab built
```
