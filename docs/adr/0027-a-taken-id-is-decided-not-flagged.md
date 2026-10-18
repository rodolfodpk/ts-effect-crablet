# ADR-0027: An id that is already taken is decided in `decide`, not flagged with `onDuplicate`

## Status

**Accepted** (2026-10-11). **Narrowed by [ADR-0034](0034-a-repeat-must-be-the-same-request.md)** (2026-10-18): a match from a *different* request under the same key (another body) is no longer "already done" but `IdempotencyMismatch` (422), and `idempotentBy: byModel()` names the pattern this record introduced. Built: `onDuplicate` is removed from `defineCommand`; the wallet's `OpenWallet` and the course app's `DefineCourse` decide a taken
id from a model. Narrows [ADR-0010](0010-declarative-command-api.md), which listed idempotency as "`idempotentBy` (+ `onDuplicate`)".

## Context

`idempotentBy` names the events that show an operation was already done. `onDuplicate` decided what a repeat answered: `"return"` (the default) reported
"already done", and `"fail"` failed the command with the framework's `Duplicate`, a 409 with `violationCode: IDEMPOTENCY_VIOLATION`.

Only two commands used `"fail"`, both of the same kind: create something under an id the caller chose (`OpenWallet` by wallet id, `DefineCourse` by course
id). Three problems:

- **A lost response could not be retried.** A client whose first open succeeded but whose answer was lost got a 409 on its retry, and could not tell its own
  success from someone else's wallet under the same id.
- **The refusal was not a domain error.** It was the framework's generic conflict, so the contract did not declare it, the OpenAPI description did not
  describe it, and a typed client could not tell it from a stale decision.
- **The option was easy to get wrong.** The default was silent, the value `"fail"` did not say what fails, and the meaning was split across two options
  that only make sense together. A command keyed on a business id that forgot the option answered "already done" to a different request.

## Decision

1. **A repeat that `idempotentBy` finds is always "already done".** `idempotentBy` is for a key that identifies one *request* (a deposit id, a transfer
   id, an automation's source event): a repeat is the same request, and the answer is success. `onDuplicate`, `Command.duplicates`, `Append.onDuplicate`
   and the executor's path that failed with `Duplicate` are removed, and so is the `IDEMPOTENCY_VIOLATION` 409 in `commands-http`.
2. **An id that is already taken is a business rule, decided in `decide`.** The command loads a model of the id, and:
   - nothing there: emit the creating event;
   - the same request again (the fields the caller sent are the ones stored): `noop`, which answers "already done" (200);
   - something else under that id: fail with a declared domain error of kind `conflict` (409), such as `WalletAlreadyExists` or `CourseAlreadyDefined`.
3. **The event store keeps `Duplicate`.** It is how an append reports that its idempotency query matched. The command executor turns it into "already
   done"; only a caller of `EventStore.append` itself sees it.

## Consequences

- A client can retry a create after a lost response and gets 200.
- The conflict is typed, declared on the contract, documented in the OpenAPI description and handled by a typed client (the course page shows it).
- Two concurrent creates of one id stay safe: each decides on the id's events under the default strict consistency, so the loser re-runs and sees the winner.
- "The same request" is judged by comparing what was sent with what is stored. Two different callers sending exactly the same create both get success, and
  one thing exists; for a create keyed by an id the caller chose, that is what both asked for. A command whose input can legitimately differ between retries
  of one request (a timestamp the client sets) must use a request id and `idempotentBy` instead.
- Each create command writes its own three branches and declares its own error. If create commands multiply, a helper that compares the payload can be
  added; it would build on `decide`, not on the append.
- The model keeps the fields it compares (the wallet's owner, which is personal data, already stored in the event and held only while the command decides).
- Breaking: `onDuplicate` no longer exists, `Duplicate` is no longer in a command's error type, and the 409 `IDEMPOTENCY_VIOLATION` is gone
  ([ADR-0013](0013-api-evolution-additive-vs-breaking.md): accepted while the project is pre-release).

## Alternatives considered

- **Keep `onDuplicate` and rename its values** (`"already-done" | "conflict"`). Clearer, and cheap, but a lost response still turns into a 409, and the
  conflict stays a framework error that the contract does not declare.
- **Make the meaning part of the idempotency declaration** (`sameRequest(query)` versus `uniqueBy(query)`). Removes the silent default, but keeps the
  untyped conflict and the retry problem of `uniqueBy`.
- **Compare the payload in the framework.** `idempotentBy` could store and compare the input. That would put a business decision (which fields make two
  requests the same) in the framework, and would need the input stored with the event.
