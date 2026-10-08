# Tutorial: course enrolment, from an in-memory test to an HTTP API

*An unfamiliar word? See the [glossary](../glossary.md). All documents: [docs/README.md](../README.md).*

You will build a small service where **a course holds at most N students** and **a student takes at most 3 courses**. Those two
rules concern two different kinds of thing, yet they are decided together, atomically, without a saga and without picking an
"aggregate" first. That is what *dynamic consistency boundaries* (DCB) are for.

In five steps you will:

1. write and test the rule **in memory** - no database, no Docker;
2. run it against **Postgres**, add the second rule, and watch two races resolve;
3. expose it as an **HTTP API** whose **OpenAPI** description is generated from your code;
4. add a **read model**, and make a read include a write (a **marker**, or the server's default) so a client reads its own write;
5. put a small **web page** (Foldkit) in front of it and see what a real client has to handle.

Every code block in these pages is a real file in this repository; a test fails if a block drifts from its file
(`examples/course-enrolment-app/test/tutorial-sync.test.ts`). Reference material, if you want it: the
[README](../../README.md), the [DCB guide](../dcb-guide.md), [ADR-0010](../adr/0010-declarative-command-api.md) and
[ADR-0011](../adr/0011-http-api-from-the-domain-model.md).

**You need:** Bun 1.4 or newer, Node 24 or newer, and (from step 2) Docker. Then, once:

```bash
git clone https://github.com/rodolfodpk/ts-effect-crablet.git
cd ts-effect-crablet
bun install
```

## The steps

| Step | You build | Needs |
|---|---|---|
| [1. The rule, in memory](01-the-rule-in-memory.md) | one rule, decided from events, tested with no database | Bun |
| [2. Postgres, and the second rule](02-postgres-and-the-second-rule.md) | the same commands on Postgres, a second rule, two races | Docker |
| [3. An HTTP API](03-an-http-api.md) | a route per command and a generated OpenAPI description | Docker |
| [4. Read your own writes](04-read-your-own-writes.md) | a read model, and reads that wait for your write | Docker |
| [5. A page that uses it](05-a-page-that-uses-it.md) | a Foldkit page on the typed client, with live updates | Docker |
| [Clean up, and where next](where-next.md) | remove the database; what to read after | - |

Each step ends with "You now have...", so you can stop after any of them and still have something that runs. Step 1 needs no Docker; steps 2-5 build on each other
and on the same database, so do them in order. Step 5 is the longest, because it is a whole page.

## If something fails

- **`docker compose up -d` fails, or the migration cannot connect:** Docker is not running, or something else holds port 5432. Stop it, or start the database on
  another port with `COURSES_DB_PORT=5433 docker compose up -d` and run every later command with the same `COURSES_DB_PORT=5433`.
- **`node src/migrate.ts` fails on a second run:** it is meant to run once per fresh database. `docker compose down -v` removes the database; start again from `docker compose up -d`.
- **The server does not start on 8080:** something else is using it. Set `PORT=8081` for the server and use that port in the `curl` examples.
- **An import fails or `node` rejects a `.ts` file:** run `bun install` at the repository root, and check `node --version` (24 or newer).
- **A `bun test` or `node` line fails with a different error:** the code in every step is a tested file, so a failure is a bug in the repository or the environment.
  Run `bun run test:unit` at the root to see which.

Start with [step 1](01-the-rule-in-memory.md).
