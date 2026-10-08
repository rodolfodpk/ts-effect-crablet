# processors-admin-ui

A small web page, written with [Foldkit](https://foldkit.dev), for the **processors admin API** ([`@crablet/processors-http`](../../packages/processors-http/README.md), [ADR-0020](../../docs/adr/0020-processors-admin-api.md)):
a table of an application's background processors (views, automations, outbox publishers) with their status, last error, cursor and how much waits for each, and **Pause**, **Resume** and **Reset** buttons.

It is **not tied to an application**. Its client is derived from the API's own definition (`processorsGroup`), so it knows the routes, the response Schemas and the problems and nothing about wallets or courses: it works against any
application that mounts the group. `kind` and `id` are shown as the application named them. Like the [course page](../course-enrolment-ui/README.md) it has no cast: a problem the API gains and the page does not handle stops it compiling.

## Run it

Start an application with the admin API mounted. The wallet example mounts it when `WALLET_ADMIN_TOKEN` is set (and not otherwise):

```bash
WALLET_ADMIN_TOKEN=change-me node examples/wallet-example-app/src/index.ts
cd examples/processors-admin-ui
bun run dev        # the dev server proxies /admin to :8080 (ADMIN_API_URL or PORT to change it), so it needs no CORS
```

Open the page, type the token, **Connect**. The token is kept in the page's memory only (a reload asks again), is sent as `Authorization: Bearer`, and a `401` ends the session so the page asks for another.
`bun run build` makes a production build; `bun run typecheck` checks the types. To call the application on its own origin instead of through the proxy, set `VITE_API_URL` (the application then needs CORS for the page's origin).

## What the buttons do

- **Pause** stops a running processor handling events; **Resume** lets it carry on from its cursor.
- **Reset** (it asks first) clears the error count, sets the status to `ACTIVE` and resumes the processor. It is how a `FAILED` processor is restarted. **It does not move the cursor**, so no event is replayed or skipped, and the text of the last error stays (shown as history).
- The list refreshes every five seconds while connected, and after each action.

## Where things are

`src/main.ts` is the Model, Messages, `update` and `view`; `src/api.ts` is the client; `src/entry.ts` starts it. The tests are in `test/`: stories on `update`, scenes on the real `view`, the error mapping, and
`test/integration/` runs the page's own `update` and commands against the real wallet example on Postgres (Docker), without a browser.
