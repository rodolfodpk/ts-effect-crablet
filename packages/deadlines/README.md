# @crablet/deadlines

Deadlines: when a time has passed, run a command. A deadline is an event in the log (`crablet.DeadlineScheduled`, set with `deadline(...)` in `decide`), and
this module fires the due ones on the same poller as views, automations and the outbox, with its own lock ([ADR-0043](../../docs/adr/0043-a-deadline-is-an-event-in-the-log.md)).
It shares no code with the other modules.

## What it gives you

- **`startDeadlinesProcessor({ commands, config })`** (the package entry point) - fires the deadlines commands set with `deadline(...)`, leader-gated
  (`makeDeadlinesProcessor` builds without starting); each firing goes through the `CommandExecutor`. `config` is a `DeadlinesConfig`, the polling
  settings plus `fireTimeoutMs`, how long one firing may take ([set a deadline](../../docs/guides/build/set-a-deadline.md)).
- **`makeDeadlinesManagementService`** (`/DeadlinesManagementService`) - inspect and control the deadlines processor, with its backlog: the deadlines due and not fired.
