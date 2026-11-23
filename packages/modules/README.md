# @crablet/modules

The contracts the background modules (views, automations, outbox, deadlines) implement, and what consumes them (the admin API, `@crablet/app`) depends on.
It holds types and one helper, and depends on nothing of the framework: a consumer depends on the contract, not on the engine or on a module.

## What it gives you

- **`ProcessorManagementService<I>`** (the package entry point): what an operator can ask of a module's processors and do to them (status, failures, cursor,
  backlog, backoff; pause, resume, reset), with its data types `ProcessorStatus`, `ProgressCursor`, `Backlog`, `ProcessorDetails`, `BackoffInfo`, and
  `isBackedOff`. `@crablet/event-poller` implements it (`makeProcessorManagementService`); each module hands one out.
- **`ProcessorSource`** (`/ProcessorSource`): one module's processors as the application names them, `{ kind, service, describe? }`, which the admin API
  (`@crablet/processors-http`) lists and acts on.
