# ADR-0034: A repeat must be the same request, and every command says how it recognises one

## Status

**Accepted** (2026-10-18). Built: migration `V16__crablet_request_fingerprint.sql` (`crablet_events.request_fingerprint`, `crablet_items_duplicate`, a duplicate that
reports what it matched), `EventStore.findDuplicate`, `Duplicate.latest` and `.requests`, `ProjectionResult.latest`, `IdempotencyMismatch`
(`@crablet/commands/Errors`), `idempotentBy: byModel()`, `assertRepeatHarmless` (`@crablet/commands/testing/Scenario`), the 422 problem and the check in
`checkImplementations` (`@crablet/commands-http`), and the metric `crablet.command.idempotency_mismatches`. Supersedes the part of
[ADR-0027](0027-a-taken-id-is-decided-not-flagged.md) that answered every match "already done", and closes the gap
[ADR-0015](0015-read-consistency-by-marker.md) recorded ("a retried command has no marker").

## Context

`idempotentBy` names the events that show a request was already handled. Three things were wrong with what happened next.

1. **A different request under the same key was "already done".** A client that reused a deposit id with another amount got `200` for money that was
   never moved. ADR-0027 accepted this to keep a lost response from turning into an error. But the cost was a silent wrong answer, and a client cannot
   detect it.
2. **A repeat had no marker.** A client whose first answer was lost, and who retried, got `"marker": null`, so it could not read its own write
   (ADR-0015, "checked, not yet fixed").
3. **Nothing required a command to say how it recognises a repeat.** The wallet's `TransferMoney` carried a `transferId` but declared no
   `idempotentBy`, so a retried transfer moved the money twice. The HTTP layer exposed it without complaint. Automations already refused such a command
   (ADR-0023); the HTTP API did not.

## Decision

**`idempotentBy` answers one question, "how is a repeat of this request recognised?", in one of two ways.**

- **A query** (`(c) => DepositMade.where({ deposit_id: c.depositId })`) is for an effect that can legitimately happen many times, where state alone
  cannot tell a retry from a new request. The framework looks the key up before deciding, and the append checks it again atomically.
- **`byModel()`** is for an effect that happens once per key (open wallet X, define course Y, subscribe S to C). The model already shows whether it
  happened, and `decide` answers the repeat: `noop(...)` for the same request, a domain error for a different one (`WalletAlreadyExists`). The framework
  looks nothing up for it. The value is a statement by the author, and `assertRepeatHarmless(Command, input, history?)` checks it in a test: it runs the
  command twice and fails if the second run appends anything, or fails for a request that succeeded.

  `byModel()` needs a model and takes no `consistency`: it decides under `strict()`, the default with a model. Two identical requests that race both load
  "not done yet"; under `strict()` the second append conflicts, the command runs again, and its fresh load shows the first, so `decide` answers it. Under
  `concurrent()` both would append, and `assertRepeatHarmless`, which runs the command twice in a row, would not see it. The type checker refuses
  `byModel()` without a model or with a `consistency`, and `defineCommand` refuses both when it runs, for callers the type checker does not see.

**A repeat must be the same request.** A command with a query key stores a fingerprint of the request on its events: SHA-256 of the command name and the
input, encoded by the command's own input schema, with sorted keys. When the key matches, what it matched decides:

- a match with the same non-null **cause** as this attempt is the same automation trigger delivered again: "already done", even if the automation built
  a different input from state that changed since;
- otherwise, a stored fingerprint that differs from this one is a **different request** and fails with `IdempotencyMismatch`. Over HTTP that is
  `422` with `violationCode: IDEMPOTENCY_MISMATCH`. The problem never echoes the input;
- anything else (the same fingerprint, or events appended before fingerprints existed) is "already done".

The rule applies both where the executor checks before deciding (`EventStore.findDuplicate`) and where the append finds the key (a request that committed
in between). Both see the same `Duplicate`, which now says what it matched.

**A repeat answers with a marker.** For a query match, the marker is the latest event the key matched. For a repeat that `decide` answers, it is the newest
event the decision read (`ProjectionResult.latest`, settled or not), and whatever made it "already done" is at or before that. The existing
`lastPosition` and `lastTransactionId` fields carry it; no new field. Over HTTP, the `IDEMPOTENT` response's `marker` is a string, or null only when there
is nothing to point at (a no-op of a command with no model).

**Every command exposed over HTTP declares `idempotentBy`.** `checkImplementations` refuses one that does not, when the layer is built, with a message
that names both forms. The wallet's `TransferMoney` now has its key, and the commands whose `decide` already answered a repeat say so with `byModel()`. A
repeated `CloseWallet` is now `noop("ALREADY_CLOSED")` rather than `WalletNotFound`.

## Consequences

- A client bug that reuses a request id is now visible: `422`, and the counter `crablet.command.idempotency_mismatches`. An automation whose key is too
  broad, one that matches another trigger's work, now fails loudly in production instead of dropping that work.
- A retried request reads its own write.
- `IdempotencyMismatch` is a framework error next to `Conflict`, in the executor's error type and on every command route in the OpenAPI description (the
  HTTP description is built from contracts, which do not know a command's `idempotentBy`).
- Storage: 32 bytes per event of a command with a query key, NULL for the rest. The lookup that reports the matches runs only on a duplicate.
- The fingerprint is a digest of input that the events already store in clear, so it reveals nothing new today. A future crypto-shredding feature must
  account for it (`Personal.ts`).

## Alternatives considered

- **Keep ADR-0027 and document it.** Rejected: a silent wrong answer, which the client cannot detect.
- **A field to narrow what is compared (`sameRequest`).** Rejected for now: a retry resends the same body. It can be added later without breaking anything.
- **A second field for the HTTP check (`repeat: "decided"`).** Rejected: it could contradict a query `idempotentBy`; one field answers one question.
- **The string `idempotentBy: "decide"`.** Rejected: a magic value next to a function, and nothing to hang the rule on (a model, no `consistency`), which
  could then only be checked when the command ran. `byModel()` is a value like `strict()`, and the type checker enforces the rule.
- **Wrapping the query too (`Idempotency.key(...)`).** Rejected: it adds noise to the most common form, and `model` and `consistency` are plain
  functions of the input as well.
- **Compare the payload stored in the command audit.** Rejected: the audit is redacted by default, can be turned off, and is purged by retention.
