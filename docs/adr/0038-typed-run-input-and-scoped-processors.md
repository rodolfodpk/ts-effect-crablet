# ADR-0038: A caller's input is typed, and a processor starts in a scope

## Status

**Accepted** (2026-10-20). Built: `RawInput` (`@crablet/commands/Command`) on `CommandExecutor.run`, `given(...).when` and `assertRepeatHarmless`
(`test/run-input.types.ts`); `startViewsProcessor`, `startAutomationsProcessor`, `startOutboxProcessor` and the `ProcessorHandle` type
(`@crablet/event-poller`). Follows [ADR-0037](0037-the-declaration-api.md).

## Context

A review of the public API after ADR-0037 found two places where the API did less than the declarations promised.

1. **`run` and `when` took `input: unknown`.** A command declares its input schema, and the HTTP API is typed from it, but a call from a script, a test or
   another service was not: `executor.run(Subscribe, { studentID: "ann", corseId: "math" })` compiled and failed at run time with `InvalidInput`.
2. **Starting a processor took two steps that had to be paired by hand.** `make*Processor` built a handle and `service.start` forked detached fibers that
   only `service.stop` interrupts, so a scope that closed without it left the loops polling a closed pool. `service.startScoped` existed, but no
   example used it: each one wrote its own start, stop and scoped wrapper, with comments warning about the hang.

## Decision

- **`run`, `when` and `assertRepeatHarmless` take `RawInput<I>`, the command's input before decoding** (`Schema.Codec.Encoded` of its schema). It is still
  validated at run time: a check such as a minimum is not in the type, and a caller that has untyped data (a transport, JSON) holds a command whose
  schema type is erased, for which `RawInput` is `unknown`. Encoded, not decoded: `run` decodes, so a field read through a transformation (a date from a
  string) is given as what it decodes from. `runDecoded` is unchanged.
- **Each module has `start*Processor(deps)`**: it builds the processor and starts it, owned by the Scope, and returns the handle. Closing the scope stops
  the loops and releases the leader lock. It is what an application uses. `make*Processor` stays, for a handle that is not started (a role this process
  does not run, whose status the admin API still reads) and for tests that drive `start` and `stop`.
- **`ProcessorHandle`** names what the modules return, instead of `EventProcessorHandle<ProcessorConfig<string>, string>`.

## Consequences

- **Breaking.** A call to `run` or `when` with a misspelt field, or with a value typed `unknown`, no longer compiles. A test that sends ill-typed input on
  purpose casts it (`as never`). The examples' `startCourseViewsScoped`, `startBackgroundProcessorsScoped` and `stopBackgroundProcessors` are removed:
  `startCourseViews` and `startBackgroundProcessors` are scoped, and the wallet's takes an options object instead of four positional arguments.
- The examples no longer stop processors by hand: the scope that owns the HTTP server owns them too, and closes the server first.

## Alternatives considered

- **Type `run`'s input as the decoded type.** Rejected: `run` decodes it, so a transformed field would be decoded twice.
- **Make `make*Processor` start the processor.** Rejected: a process that does not run a role still needs that role's handle, unstarted.
