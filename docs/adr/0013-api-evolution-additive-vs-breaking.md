# ADR-0013: How the public API evolves - additive versus breaking

## Status

Accepted, and then narrowed by the project owner: **this project is pre-release with no external consumers, so it makes no promise of API stability. A breaking change is fine whenever it is worth it.** What remains of this ADR is the vocabulary (so a change is labelled honestly) and what to do once the situation changes. The machinery it first sketched - frozen per-version snapshots, a breaking-change diff test, versioned paths - is deferred until the first external consumer exists or a 1.0 is declared (`docs/history/plans/api-follow-ups.md`, item B).

**Update (2026-11-23): the breaking-change diff test is built, early, in a smaller form.** The project owner asked for it now, with several products in one monorepo and clients that are not TypeScript (a page derives a typed client from the API definition and has a compiler; `curl`, another language or another product reads `/openapi.json` and has none; `docs/reference/http.md`, "Two kinds of client"). It is `scripts/openapi-breaking.ts`: each `docs/api/*.json` at the **base branch** against the working tree, classified by the vocabulary below, run by CI on every pull request. It compares with the base, not with a frozen snapshot, because a snapshot regenerated in the same change always equals what the code generates. The promise is unchanged: a break is allowed, and it is allowed when a commit of the change says "breaking" in its message (the rule below), so the script only makes a break visible and deliberate. Frozen `-v1` snapshots and versioned paths stay deferred as the next paragraph says.

## Context

The HTTP API and its OpenAPI description are derived from the domain model (ADR-0011), so every change to a command, an error or a response shows up in the description. The checked-in documents (`docs/api/*.json`) are compared byte for byte: that tells us the API changed, not whether the change could break a client. Today the only consumers are in this repository (the Foldkit page), deployed together with the server and checked by the compiler against every change, so a breaking change costs one commit that updates them.

## Decision

**Break the API when it is worth it.** No deprecation period, no compatibility shims, no version bump. A breaking change updates every consumer in this repository (examples, tutorial, tests, the generated documents) in the same commit, and says "breaking" in its message.

**Vocabulary, so the label is honest.**
- *Additive*: a new route; a new OPTIONAL request field or query parameter; a new field on a response or problem body; a new declared problem; a new value of a response enum. Clients are expected to ignore response fields they do not know.
- *Breaking*: removing or renaming a route, a response field, a declared problem or a status code; a new REQUIRED request field; narrowing what a request accepts; widening a response in a way clients branch on.

**When this changes** (the first external consumer exists, or a 1.0 is declared): freeze a version as a committed snapshot `docs/api/<name>-v1.json`, version by path prefix through the existing `basePath` (`/v1/commands`), and make the test compare with that frozen snapshot instead of the base branch (it then fails on any BREAKING difference, with no "breaking" message to excuse it). Until then only the comparison with the base branch exists (the update in Status); the snapshots and the versioned paths are not built.

## Consequences

- The byte-for-byte comparison stays as the drift alarm: an API change shows up as a diff in review, whichever kind it is. `scripts/openapi-breaking.ts` says which kind: it reports the breaking differences from the base branch (a route, an answer or a response field removed or retyped, a new required request field or parameter, a request narrowed) and ignores the additive ones. It reads the shape, not the meaning: a changed behaviour behind the same shape is still for review.
- Designs do not carry compatibility cost: for example the contract/behavior split (plan item F) replaces the old way instead of supporting both.
- The first changes made under this ADR, all additive: the `errors` member of the 400 problem (field-level validation issues), and the planned `lastTransactionId` in the command response and the course list endpoint.
