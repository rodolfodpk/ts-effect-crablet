# course-enrolment-ui

A small web page for the course-enrolment API, written with [Foldkit](https://foldkit.dev) (an Elm-style framework on Effect). It is the first real **client** of the
HTTP API: it builds a typed client from the same contracts as the server, sends the write's marker on its next read, shows domain refusals as typed problems, and
updates a second tab through the live-updates ping. [Tutorial step 5](../../docs/tutorial/05-a-page-that-uses-it.md) walks through it.

## Run it

Start the API first (see [course-enrolment-app](../course-enrolment-app/README.md)), then:

```bash
cd examples/course-enrolment-ui
bun run dev        # the dev server proxies the API, so it needs no CORS
```

`bun run build` makes a production build; `bun run typecheck` checks the types. To call the API on its own origin instead of through the proxy, set `VITE_API_URL`
(the API then needs its opt-in CORS).

Where it sits among the containers: [C4 models](../../docs/c4-examples.md#course-enrolment).

## Where things are

`src/main.ts` is the Model, Messages, `update` and `view`; `src/api.ts` is the client; `src/entry.ts` starts it. The page's tests are in `test/`.
