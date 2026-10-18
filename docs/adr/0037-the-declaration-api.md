# ADR-0037: The declaration API: one shape, checked by the type checker

## Status

**Accepted** (2026-10-18). Built:
- `byModel()` (`@crablet/commands/Command`), replacing `idempotentBy: "decide"` ([ADR-0034](0034-a-repeat-must-be-the-same-request.md));
- the model's tag check (`@crablet/commands/Model`, `test/model.types.ts`) and `typeof Event.Type`;
- `defineContract`, renamed from `commandContract`;
- `defineAutomation(name, command).on(...)` (`@crablet/automations/AutomationHandler`), replacing `automationHandlerOf`;
- `makeViewsProcessor({ views, overrides })` and `makeAutomationsProcessor({ automations, overrides })`;
- a view's declared selection (`defineView(name, { tables, anyOfTags })`) and consistent reads that take views (`reads: [View]`);
- `withOverridesByName` (`@crablet/event-poller/ProcessorRuntimeOverrides`);
- `crablet.internal` lists for `@crablet/automations` (`./AutomationDecision`) and, in `@crablet/views`, `./ViewProjector` and `./ViewSubscription` ([ADR-0031](0031-api-and-plumbing-are-separate.md)).

Builds on [ADR-0026](0026-views-declared-as-operations.md) (views declared as operations) and [ADR-0010](0010-declarative-command-api.md) (the
declarative command API).

## Context

A review of the public API found that the domain core read well: `defineEvent`, `defineModel().on()`, `defineCommand` with a pure `decide`
returning `emit`, `noop` or `fail`, and `defineView().on()`. Around it, four things worked against adoption and against consistency.

1. **Automations looked different from everything else.**
   - `automationHandlerOf(name, command, decideFn, { eventTypes: new Set([...]) })` took positional arguments, decoded each event by hand and needed long explicit types.
   - It had its own `executeCommand` and `noOp`; commands have `noop`.
2. **Views had two ways to be written, and two lists to wire.**
   - A hand-written projector (`makeTransactionalViewProjector` plus `viewSubscriptionOf`) repeated the view's name and its event types, although `defineView` already had an escape hatch, `raw`.
   - The processor took `projectors` and `subscriptions` as two lists that had to match by name, and each example view had a `makeXViewProjector` wrapper.
3. **A model's `by` was a plain string, and `.on` took any event.**
   - An event that did not carry the tag (a typo in `by`, a forgotten tag) matched nothing: the fold missed it in silence, and so did the boundary, so a concurrent change to it no longer conflicted.
   - The check found one such model in the framework's own tests.
4. **Names and values did not match their neighbours.**
   - `idempotentBy: "decide"` was a magic string next to a function.
   - `commandContract` stood apart from the `define*` functions.
   - An event's payload type had to be written `ReturnType<typeof X.decode>`.
   - Comments on the command spoke of HTTP, although a command runs the same from a script, an automation or a test.

## Decision

**One shape: `define*(name, …).on(Event, handler)`, with pure handlers.**
- **Models, views and automations are all declared this way.** A handler gets the event's decoded data (and a `ctx` with the stored event, its position and its tags) and returns data:
  - a model returns its next state;
  - a view returns its operations;
  - an automation returns the command's input: one, several, or `undefined` for none. When the input is itself an array, only a list of inputs is accepted, so one input is never taken for several.
- **What each one reads comes from its `.on` handlers**, so the selection cannot drift from what it does.
- **Each event is decoded with its own definition**, and one that cannot be decoded fails, never skipped ([ADR-0017](0017-event-evolution-by-compatibility.md)).
- **A view or an automation with no `.on` is refused** when its processor is built.

**`define*` declares; `make*` runs.**
- **What a view or an automation reads besides its event types is part of what it means**, so it is declared with it. For example, the wallet's views read any event that names a wallet: `anyOfTags`.
- **Polling interval, batch size and backoff are deployment settings.** They go to the processor, by name: `overrides: { "wallet-statement-view": { batchSize: 100 } }`. An override for a name the processor does not run is refused.
- **The processors take what was declared:** `makeViewsProcessor({ views })`, `makeAutomationsProcessor({ automations })`. A consistent read takes the views it reads too.

**One way to write a view.**
- **`defineView` is the only way**, and a handler returns `raw((sql) => …)` for what the table operations cannot say.
- **A view still declares its tables**, so the drift check covers a view that writes with its own SQL.
- **The engine under `defineView`** (`makeTransactionalViewProjector`, `viewSubscriptionOf`) is plumbing: listed as internal, for tests of the processor.

**A pure automation handler.**
- **It maps the event to a request.** A decision that needs state belongs in the command (`model`, `resolve`), where it is consistent.
- **An input built from the trigger also makes a redelivery the same request** ([ADR-0035](0035-the-same-trigger-cannot-append-the-same-request-twice.md)).
- **What this removes:** an automation's `decide` was an `Effect`, and could read state. Nothing in the examples or the guide did. The runtime shape (`AutomationHandler`, `AutomationDecision`) stays, for the processor and for tests of the dispatch.

**What the type checker can know, it checks.**
- **A model's tag.** `defineModel` keeps `by` as a literal type, and `.on` and `.lifecycle` accept only an event whose declared tags include it, or every key `{ by: [...] }` names. The compiler says `this event does not carry the tag "…" the model binds through`.
  - Tags a command adds at append time are not checked, because they are not in the event's own `tags`: `extraTags`, which a model's `scope` relies on.
  - Keys that are not known exactly (a `by` held in a variable typed `string`) cannot be checked, and are accepted.
- **`byModel()`.** It requires `model` and refuses `consistency` ([ADR-0034](0034-a-repeat-must-be-the-same-request.md)).
- **A wrong value.** A string where `idempotentBy` expects a query or `byModel()` gets a message naming the two forms.

**Names and comments.**
- **`defineContract`.** A contract stays one object spread into `defineCommand`, so the input schema is written once and a browser can import it without the domain ([ADR-0011](0011-http-api-from-the-domain-model.md)). It is optional.
- **`typeof DepositMade.Type`** names an event's payload, as an Effect `Schema` does.
- **The command's comments talk about callers that may repeat a request** (a client retry, an automation redelivery), not about HTTP.

**Names that key state stay.** An automation's or a view's name keys its progress row, its cursor. Renaming one would start it again from the
beginning of the log, so none was renamed.

## Consequences

- **Breaking.** `automationHandlerOf`, `commandContract`, `idempotentBy: "decide"`, the `projectors`/`subscriptions` and `handlers` fields of the processors, and the examples' `makeXViewProjector` and `xViewSubscription` exports are removed, with no aliases. The project is pre-release ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)).
- **What an application imports for views and automations shrinks**: `defineView`, `viewTable`, `raw`, `defineAutomation`, and the two processors.
- **A mistake in a model's tags, in `byModel()`, or in the value of `idempotentBy` is a compile error**, not a silent hole in a boundary or a defect at run time.
- **The type rules depend on `defineEvent`'s result.** An event built by hand without a `where` is not checked.

## Alternatives considered

- **Keep `automationHandlerOf` beside `defineAutomation`.** Rejected: two ways to say one thing is what the review was about.
- **Put polling and batch settings in `defineView`/`defineAutomation`.** Rejected: they are deployment settings. Declared with the view, they could not differ between deployments without changing the domain code.
- **Check a model's `scope` tags as well.** Rejected: a command adds them at append time (`extraTags`), so the events do not declare them, and the check would refuse correct models.
- **Move the contract to `@crablet/commands-http`.** Rejected: the domain would then import the HTTP package to define its commands. Deriving the API from the commands instead would put the domain in the browser's bundle.
- **Infer from `decide` (it can return `noop`) that a command answers repeats itself.** Rejected: too implicit, and `noop` also means "nothing to do".
