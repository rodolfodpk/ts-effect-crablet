// Everything a domain file declares with, from one place: events, models, periods, commands, contracts, domain errors, personal data and tags.
//
//     import { all, byModel, defineCommand, defineEvent, defineModel, DomainError, emit, fail, noop } from "@crablet/commands/Domain";
//
// It re-exports the narrower entry points (`/Event`, `/Model`, `/Period`, `/Command`, `/Contract`, `/Errors`, `/Personal`, and `Tag` from
// `@crablet/eventstore/Tag`), which stay. It reaches the command pipeline, so a module a browser imports (a contract, the errors) keeps
// importing `/Contract` and `/Errors` instead. Running, testing and wiring are elsewhere: `CommandExecutor` (`@crablet/commands`),
// `Crablet.layer` (`/Crablet`), `given` (`/testing/Scenario`).
export { defineEvent, type EventDef } from "./Event.ts";
export { all, defineModel, type HandlerCtx, type ModelInstance, type PeriodInfo } from "./Model.ts";
export { Period, type PeriodSpec } from "./Period.ts";
export {
  byModel,
  concurrent,
  defineCommand,
  emit,
  fail,
  noop,
  strict,
  type Command,
  type Consistency,
  type DecideContext,
  type Decision,
  type RawInput,
  type ResolveReader
} from "./Command.ts";
export { defineContract, type CommandContract } from "./Contract.ts";
export { DomainError, type ErrorKind } from "./Errors.ts";
export { personal } from "./Personal.ts";
export * as Tag from "@crablet/eventstore/Tag";
