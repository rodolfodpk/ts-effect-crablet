# chaos-ui

A page for the kind lab ([the lab](../../docs/plans/kind-lab.md)), written with [Foldkit](https://foldkit.dev): break the wallet's pods on purpose and see who takes over, whether anything is lost, and whether the data is still consistent afterwards.
It is a **lab tool**, not part of the framework or of an application: it can delete pods and empty a database, so it only talks to the kubectl context `kind-crablet-lab`.

## Run it

The lab has to be up (`node examples/wallet-example-app/lab/lab.ts observe`). Then, in two terminals:

```bash
node examples/chaos-ui/server/server.ts     # the server: runs kubectl and talks to the lab's Postgres, on 127.0.0.1:5174 (a browser cannot do either)
cd examples/chaos-ui && bun run dev          # the page, on http://localhost:5175 (it proxies /api to the server)
```

## What is on the page

- **Leaders**: the pod that leads views, automations and outbox, and the changes since you opened the page.
- **Load**: start and pause the load generator, and set the seconds between bursts, the fewest and the most commands in a burst, and the number of wallets. It changes while the generator runs, with no restart
  (the generator serves `POST /config` on its control port; the server reaches it with a port-forward).
- **Chaos run**: choose the faults, how many minutes, how often, and how long a cut or a pause lasts. Each fault is one of the chosen ones, at random, and each is logged with how long another pod took to lead.
  The faults: kill the leader of a module, kill a worker or an API pod, a rolling update of the workers, cut the views leader from Postgres (packets dropped, then healed), pause a view.
- **Pods**: every pod, with a Kill button for the API and worker pods (never Postgres, Grafana or the load).
- **Is the data consistent?**: pauses the load, waits for the processors to catch up, then checks the event log against what was built from it: the balance and summary views against the sum of the moves, no overdraft,
  nothing applied twice, one welcome notification per wallet, the audit, one leader per module. A run can do it by itself when it ends.
- **Start from zero**: empties the log, the commands, the views and the processors' progress (it asks first), and has the load open new wallets.

## What it found

The first thing the consistency check found was in the wallet, not in the lab. Deposits are `concurrent` (they commute), so the `newBalance` a deposit records is the balance of the moment it was decided and can be stale when another
credit commits meanwhile. The wallet's balance and summary projections **copy** that number instead of applying the amount, so after concurrent credits 22 to 28 of 425 to 625 wallets showed a balance other than the sum of their events.
The log was right and the views were wrong. Reported as FAIL on the page until the projectors apply the amount (`balance + amount`).

## Where things are

`src/contract.ts` is what the page and the server say to each other (both import it); `src/main.ts` is the Model, Messages, `update` and `view`; `server/server.ts` is the server and `server/checks.ts` the data checks.
Tests: `test/` (stories on `update`, scenes on the real `view`).
