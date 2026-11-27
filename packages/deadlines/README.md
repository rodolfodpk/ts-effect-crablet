# @crablet/deadlines

Deadlines: when a time has passed, run a command. A deadline is an event in the log (`crablet.DeadlineScheduled`, set with `deadline(...)` in `decide`), and
this module fires the due ones on the same poller as views, automations and the outbox, with its own lock ([ADR-0043](../../docs/adr/0043-a-deadline-is-an-event-in-the-log.md)).
It shares no code with the other modules.

Setting a deadline is not here: `deadline(...)` and the two events are `@crablet/commands`' (`@crablet/commands/Domain`), because `decide` returns one
and the command's append writes it into `crablet_deadlines`. This package depends on the commands, not the other way round.

## What it gives you

- **`module({ commands, config, describe })`** (the package entry point) - the deadlines module, which `@crablet/app` runs: it fires the deadlines commands
  set with `deadline(...)`, leader-gated; each firing goes through the `CommandExecutor`. `config` is a `DeadlinesConfig`, the polling
  settings plus `fireTimeoutMs`, how long one firing may take ([set a deadline](../../docs/guides/build/set-a-deadline.md)).
- Its management service reaches the admin API through `Processors`, with its backlog: the deadlines due and not fired.

## Internal

`./DeadlinesProcessor` (`makeDeadlinesProcessor`, `startDeadlinesProcessor`) and `./DeadlinesManagementService` are listed under `crablet.internal` in
[`package.json`](./package.json): the module builds on them, and so do the package's tests; they can change without notice ([the boundary](../../docs/reference/README.md#public-api-and-plumbing)).
