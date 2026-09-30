import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";

// A command that does nothing, accepting any input: for tests of the automations machinery that only
// need SOMETHING to bind (the command itself is never run because the executor is faked).
export const testCommand = defineCommand({ name: "TestCommand", input: Schema.Unknown, decide: () => noop() });
