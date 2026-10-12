# ADR-0029: A command's lookup cannot write, and what it reads is protected

## Status

**Accepted** (2026-10-11). Built: `defineCommand`'s `prepare` is replaced by `resolve`. Narrows [ADR-0010](0010-declarative-command-api.md).

## Context

`prepare(input, eventStore)` ran before a command's model was loaded, inside its transaction. It was there for one reason: the wallet's commands opened
the statement period in it, before the framework learned to turn a period itself (`.period`, [ADR-0025](0025-the-framework-turns-the-period.md)). Its
result was passed positionally to `model` and `decide`. Two problems remained after the wallet stopped using it:

- **It could append, with no condition unless the author added one.** Two commands that each appended in `prepare` both committed. The wallet's statement
  opening did exactly that: commands racing on a new wallet opened several statements, and deposits were lost (every wallet in a 60-wallet race,
  `examples/wallet-example-app/test/integration/unguarded-opening-balance.test.ts`).
- **What it read was not protected.** The append condition covered what `model` loaded, not what `prepare` read. A lookup that changed before the append
  (a library card cancelled after the card was looked up) went unnoticed, and the command decided on stale data.

A step before the model is still a general need: the model's id is sometimes not in the input, and has to be looked up first (a card number names a
member; an IBAN names an account). A lookup by a key that events carry as a tag can be a model of its own, but a chained one (the second model's id comes
from the first lookup) cannot be expressed with `all(...)`, whose members are chosen from the input.

## Decision

1. **`prepare` is replaced by `resolve(input, read)`.** `read` offers `load(model)` and `exists(query)` and has no `append`, so a write does not compile.
2. **Everything `resolve` reads joins the command's condition**, the way `all(...)` joins its members: the queries are added, and the cursor is the
   earliest read horizon.
   - `strict()`: the boundary is the model's boundary plus the lookups.
   - `concurrent({ guard })`: the lookups are added to the guard.
   - `concurrent()` without a guard: the lookups become the guard.
   - A lookup that covers an event type the command appends cannot be a guard (concurrent runs would refuse each other): the condition is then strict
     over the model and the lookups.
   A lookup that changes before the append refuses it, and the command runs again with a fresh lookup. Nothing changes in the event store or the SQL.
3. **The result is named:** `model(input, { resolved })`, `consistency(input, { resolved })`, `decide(state, input, { now, resolved })`. The positional
   `prepared` argument is gone.
4. **The default consistency stays** (`strict()` with a model, `concurrent()` without) and is documented: a model can only make a command stricter,
   because without one `decide` has no state to protect. Making `consistency` mandatory was considered and rejected: it would cost a line in every command
   and prevent no wrong result.

## Consequences

- A command cannot write before its decision. Every write goes through `decide` and the command's own condition.
- A command never decides on a lookup that changed: `test/integration/resolve-lookup-postgres.test.ts` cancels the card after the lookup and the command
  is refused and re-run; with the lookups removed from the condition, that test fails.
- Two commands can no longer deadlock each other (one append, writer locks in sorted order). The executor still treats a Postgres deadlock as a
  `Conflict`, because a command can deadlock with an application transaction that appends several times in its own order
  (`test/integration/deadlock-retry.test.ts`).
- A domain that needs two separate appends in one command loses that. It is two commands, or one `decide` that emits all the events under one condition.
- Breaking: `prepare` no longer exists, and `decide` and `model` changed shape ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)).

## Alternatives considered

- **Remove the step entirely.** Leaves a chained lookup with no supported way to be expressed.
- **A read-only step whose reads are not protected, documented as such.** Simpler, but leaves a silent wrong decision in place, the kind of leak this
  change is meant to remove.
- **Let the model function itself be effectful** (`model: (input, read) => Effect<ModelInstance>`). Folds the lookup into the model, but hides the lookup
  inside what is otherwise a description of the state, and gives `decide` no access to the looked-up value.
