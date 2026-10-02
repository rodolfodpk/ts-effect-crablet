# ADR-0013: How the public API evolves - additive versus breaking

## Status

Accepted. The rules are in force now; the automated alarm for them (a frozen snapshot per version, and a test that fails only on a BREAKING difference) is planned (`docs/plans/api-follow-ups.md`, item B).

## Context

The HTTP API and its OpenAPI description are derived from the domain model (ADR-0011), so every change to a command, an error or a response shows up in the description. Today the checked-in documents (`docs/api/*.json`) are compared byte for byte: that tells us the API changed, not whether the change can break a client. There are two kinds of consumer. A TypeScript page in this repository (the Foldkit example) is deployed together with the server and can follow `main`. An external client - another language, generated from the OpenAPI document - cannot be updated in lockstep and needs a stable contract.

## Decision

**Additive changes are always allowed** and need no version change:
- a new route; a new OPTIONAL request field or query parameter;
- a new field on a response or on a problem body; a new declared problem (a new domain error a command can answer with); a new value of a response enum.

**Breaking changes need a new version**:
- removing or renaming a route, a response field, a declared problem or a status code;
- a new REQUIRED request field, or making an optional one required;
- narrowing what a request accepts (a tighter type, a smaller enum, a stricter check);
- widening what a response can contain in a way a client branches on (for example a new value of a field that clients switch on and were told was closed).

Clients must therefore ignore response fields they do not know (this is what makes "a new response field" additive), and must treat an unknown problem `errorType` as a generic failure.

**Versions are paths.** A frozen version lives under its own path prefix, set through the existing `basePath` of the command API (`/v1/commands`) and the read groups' paths, with a committed snapshot `docs/api/<name>-v1.json` as the contract. Nothing is versioned until the first external consumer exists; until then the API follows `main` and a change only needs its snapshot regenerated in the same commit.

**The alarm.** Once a version is frozen, a test compares the generated document with the frozen snapshot and fails only when the difference is breaking by the rules above (an additive difference passes and asks for the snapshot to be regenerated). Until a version is frozen, the byte-for-byte comparison stays as the drift alarm.

## Consequences

- A change's commit message and review say "additive" or "breaking"; the first additive changes under this ADR are the `errors` member of the 400 problem (field-level validation issues), `lastTransactionId` in the command response, and the course list endpoint.
- A TypeScript client derived from the definition (the Foldkit page) is checked by the compiler against every change, so it needs no version; external clients rely on the frozen snapshot.
- The rules are a judgement about clients, not something a tool can fully decide; the planned diff test encodes the mechanical part (removed or renamed things, new required fields, narrowed types) and leaves the rest to review.
