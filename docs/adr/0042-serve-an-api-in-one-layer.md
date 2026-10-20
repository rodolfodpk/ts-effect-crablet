# ADR-0042: An API is served in one layer, and its groups are typed against it

## Status

**Accepted** (2026-10-20). Built: `serveApi` (`@crablet/commands-http/ServeApi`), `problemOf` (`@crablet/commands-http/ProblemDetail`); the course
and wallet apps' read and feed groups. Tests: `serve-api.types.ts`, and the integration tests that count the LISTENs (`session-clients.test.ts`,
`course-feed.test.ts`).

## Context

Serving an API took about fifteen lines of layers in each app: the router from `HttpApiBuilder.layer`, the command group, each other group with the
view progress hub provided to it separately (so that one hub, one LISTEN, was shared, ADR-0016), the documentation page and CORS. Each hand-written
group was generic over any `HttpApi` and cast `HttpApiBuilder.group as any`, because a generic API cannot be shown to contain the group, so every
`parse` and handler had its request type written by hand and nothing checked the responses. With the casts removed, the type checker found two
things they hid: a read failed with `domainProblemOf(...)`, typed `object`, and the live feed returned a stream that still needed the hub and the
database although the endpoint takes a stream that needs nothing.

## Decision

- **`serveApi(api, { commands, groups, openApiPath, docs, cors })`** returns the API's whole layer. A group the API declares and `groups` does not
  implement stays a requirement of the layer, so it does not compile. What the groups need is provided once, to that layer: every group is built in
  that context, so the reads and the feed share one hub.
- **A group is written against the app's API type** (`type CourseApi = ReturnType<typeof makeCourseApi>`), not generic over any API: its handlers
  are inferred and checked against their endpoints, with no cast and no annotation.
- **`problemOf(error)`** is a domain error's problem typed from the error, for a hand-written endpoint that declares `problemSchemaOf(ErrorClass)`;
  an error the endpoint does not declare does not compile. `domainProblemOf(kind, error)` stays for the command group, which is dynamic.
- **A streamed response takes the group's services when the group is built** (`Effect.context()`, `Stream.provideContext`), so the services are a
  requirement of the group's layer, met once, and not a per-request one that `Layer.provide` cannot meet.

## Consequences

- An app serves its API in one call; the course app's `makeCourseApiLayer` went from layer nesting to one `serveApi(...).pipe(Layer.provide(hub))`.
- The command group keeps its internal cast (`makeCommandApiGroupLive`): its endpoints are one per contract, known only at run time.
- Additive: `makeCommandApiGroupLive`, `apiDocsLayer`, `apiLayerOptions` and `corsLayer` stay for an app that composes by hand.

## Alternatives considered

- **Derive read endpoints from views.** Not done: reads stay hand-written (no query engine, as decided before), and this only removes the wiring.
- **Provide the hub per request (`HttpRouter.provideRequest`).** Rejected: it would build a hub, and open a LISTEN, for every request.
- **Put `serveApi` in `@crablet/views-http`, to provide the hub itself.** Rejected: an API with no views would depend on the views, and providing the
  hub once is one line.
