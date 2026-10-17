# ADR-0031: A package's API and its plumbing are separate, and the line is enforced

## Status

**Accepted** (2026-10-13). Built: `crablet.internal` lists in the `package.json` of `@crablet/eventstore`, `@crablet/event-poller` and `@crablet/views`, and
`scripts/public-api.test.ts`. Relates to [ADR-0013](0013-api-evolution-additive-vs-breaking.md), which says how the API may change but not what the API is.

## Context

A package's entry points (up to 19 in `@crablet/eventstore`) were all alike: every file under `src/` that another package imports was an `exports` entry, so the API and the parts the
sibling packages build on looked the same. Counting the imports of the 82 entry points, 15 were imported only by sibling packages' sources and by no example, tool or document: `@crablet/event-poller`'s fetcher, handler and progress-tracker
interfaces and their Postgres versions, `@crablet/eventstore`'s reconnecting LISTEN and wake-up payload, `@crablet/views`' progress channel and wait rule. An application had
no way to tell them from what it was meant to use, and the READMEs described some of them as features.

Whether `@crablet/event-poller` is a library applications build their own processors on, or only the engine behind the views, automations and outbox modules, was never decided. The
README called it "the shared base" the modules build on; there is no guide and no example for writing a processor.

## Decision

1. **`@crablet/event-poller` is the engine behind the three modules, not a way to write your own processor.** No guide or example promises otherwise.
2. **A package lists its plumbing under `crablet.internal` in its `package.json`:** the entry points only the sibling packages build on. They are described in the package's README under
   "Internal" and can change without notice. Today: `eventstore` (`CorrelationContext`, `Listen`, `NotifyPayload`), `event-poller` (`BackoffState`, `EventFetcher`, `EventHandler`,
   `PostgresProgressTracker`, `ProgressPing`, `ProgressTracker`, `SqlEventFetcher`), `views` (`ViewProgress`, `ViewVerdict`; `ViewVerdict` has since moved inside the package, ADR-0015's update of 2026-10-17).
3. **The line is a test.** `scripts/public-api.test.ts` fails when a list names something that is not an export, and when an example's or a tool's source, or a document, imports an
   internal entry point. Tests and diagnostics may: they are inside the project.
4. **No rename.** The entry points keep their paths. Several types that look unused by applications are part of public shapes (`EventSelection` is the filter fields of a view
   subscription, `ProcessorRuntimeOverrides` its overrides), so the lists are made by judgement, not by counting imports.

## Consequences

- Promoting an entry point to the API is a deletion from a list plus documentation; demoting one is breaking for anyone who imported it ([ADR-0013](0013-api-evolution-additive-vs-breaking.md)). Starting small is the cheap direction.
- Not enforced for what tests and diagnostics import.
- The public list is not generated: the reference says where to find the plumbing and what the test enforces; the API is what remains.

## Alternatives considered

- **Move the plumbing under `./internal/*` paths.** Makes the boundary visible in every import, but breaks every sibling import, and the line between types that are public through a signature and
  plumbing is a judgement an automatic rename gets wrong.
- **Treat `event-poller` as an extension point.** Needs a guide and an example for writing a processor, and a promise to keep the fetcher, handler and tracker interfaces stable. Nothing asked for it.
- **Leave the boundary unwritten.** Costs nothing now, and means the first application to depend on a tracker decides it for us.
