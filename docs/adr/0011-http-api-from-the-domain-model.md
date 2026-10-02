# ADR-0011: The HTTP API and its OpenAPI description are derived from the domain model

## Status

Accepted (OpenAPI plan, Phases 0-5)

## Context

`commands-http` exposed ONE generic route, `POST /api/commands`, taking an untyped `{ commandType, command }` envelope. That
made the generated API description useless (it documented no command), pushed every client to guess request shapes, and left
a command's failures undocumented: an app had to hand-write a problem class and a `mapError` hook per error just to get a
proper 404 or 409. Meanwhile everything needed to describe the API already existed in the domain: each command has an input
`Schema`, and each `DomainError` has a `kind` and typed fields.

## Decision

- **One route per command**, `POST {basePath}/{name}`, built from the app's registry when the API is built (a loop of
  `HttpApiEndpoint.post` plus a loop of handlers; the group's static type is erased at that one boundary). The request body is
  the command's input schema. The generic envelope endpoint is removed (the packages are unpublished, so no shim).
- **A command declares its domain errors once, on `defineCommand`** (`errors: [WalletNotFound, ...]`). `decide` and `prepare`
  may only fail with a *domain* error that is listed (a missing class is a compile error naming it); errors that are not
  domain errors are unaffected. The list must exist at run time because types are erased and a function body cannot be
  inspected; declaring it on the command (rather than at exposure) keeps it next to `decide`, makes the check bidirectional and
  keeps the domain independent of the transport. An earlier design declared it at exposure to avoid an inference circularity
  that turned out not to exist.
- **Problems are RFC 7807 as `application/problem+json`.** A declared error is presented by its kind (404 / 400 / 409 / 403)
  with `type`, `title`, `status`, `detail`, `errorType` (its tag) and `fields` (its own fields). Each declared error is a typed
  component of the description, shared by every route that declares it. `mapError` and `extraErrors` are removed.
- **Handlers decode the body themselves** (`handleRaw` + the command's `decodeInput`), so a malformed or invalid body answers
  with the same problem body as every other 400; HttpApi's own payload decoding answers an empty-bodied 400.
- **The description is a build artifact:** served at `/openapi.json` (movable, can be turned off), with an optional Scalar or
  Swagger page, and checked in for the wallet at `docs/api/wallet-openapi.json` (`bun run docs:api`); a unit test validates it
  (`@readme/openapi-parser`) and fails when the file is stale, so an API change is a visible diff.
- **Read-your-writes over HTTP:** `?waitFor=<view>&waitTimeout=<ms>`. The response always carries `lastPosition` (a string; the
  position is a bigint). The app supplies `viewWaiters` (one function per view; `commands-http` does not import the views
  package). A view that does not catch up is reported in the body (`view: { name, caughtUp, reason? }`), never as an error status:
  the command has succeeded, and an error status would invite a retry of a finished write. Parameters are validated before the
  command runs.
- **Rules for exposed schemas**, enforced by a lint and by tests: use `Schema.Finite` / `Schema.Int` (not `Schema.Number`, which
  is described as "a number or the strings Infinity/NaN" and loses its checks) and `Schema.optionalKey` (not `Schema.optional`,
  which is described as nullable although the decoder refuses null).
- **GraphQL was considered and not adopted.** It would need a schema generator we would have to write, would lose status-based
  behaviour (domain failures are 200s), and adds surface to secure; revisit only if clients need flexible queries or subscriptions.

## Consequences

- Defining a command and listing its errors is all it takes to get a typed route, a request schema, documented failures and
  an entry in the OpenAPI document. A wrong or missing error declaration fails the build.
- Behaviour changes for HTTP clients (all deliberate): no envelope, `application/problem+json`, domain errors presented as
  `{ errorType, fields }` instead of app-specific problem classes, an unknown command is a 404 (no route).
- The derived client (`HttpApiClient.make(makeWalletApi())`) works with no codegen, including typed domain errors and
  `waitFor`, but it is *untyped* for the command routes: the endpoint set is built at run time, so the group's static type is
  erased. The read endpoints, declared statically, are typed. Fully typed command clients come from running an OpenAPI
  generator on the document.
- Read endpoints (views) are still declared by the app with their own response schemas; they appear in the same document but
  are not generated from the domain model.
- A route's query parameters are plain strings validated by the handler, so the description lists the allowed views in text
  rather than as an enum.
- `Schema.optional` / `Schema.Number` in an exposed input are reported by `inputJsonSchemaProblems`; the wallet's read
  responses and error fields use `Schema.Finite` and the test asserts the whole document is free of the Infinity enum.

## Addendum (2026-10-02): the command group is typed per command

`makeCommandApiGroup` used to return `HttpApiGroup<"commands", any>` (the group is built in a loop over the registry), so a client derived from the API
had `any` for every command route. It is now generic over the registry and returns a precise type: one endpoint `execute_<name>` per command, whose payload is the
command's own input Schema and whose failures are the framework's three problems plus one problem per declared domain error (exact `errorType` and `fields`),
alongside the client's own `HttpClientError` and `SchemaError`. To make that possible a defined command now keeps its input Schema and declared error classes in its
type (`Command<In, Err, I, Es>`, the new parameters defaulting to the erased types). The runtime and the generated OpenAPI document are unchanged.

Consequences: a registry must be an object literal WITHOUT a `Record<string, ...>` annotation (that forgets the command names; the client then falls back to a single
loosely typed endpoint); callers still pass `query: {}` (the endpoint's request type requires the key); `title` and `status` of a domain problem are typed as
`string` and `number` (a class carries its `kind` as a union), while `errorType` and `fields` are exact. The Foldkit page (tutorial step 5) calls the typed methods with no cast and
matches exhaustively on the declared errors. Types are pinned by `packages/commands-http/test/typed-client.types.ts` and `packages/commands/test/command-types.types.ts`.

