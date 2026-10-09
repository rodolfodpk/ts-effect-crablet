import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { defineEvent } from "@crablet/commands/Event";

const TestCommandDone = defineEvent("TestCommandDone", { schema: Schema.Struct({}), tags: () => ({ test: "x" }) });

// A command that does nothing, accepting any input: for tests of the automations machinery that only
// need SOMETHING to bind (the command itself is never run because the executor is faked). It declares `idempotentBy` because an automation
// requires one.
export const testCommand = defineCommand({
  name: "TestCommand",
  input: Schema.Unknown,
  idempotentBy: () => TestCommandDone.where({ test: "x" }),
  decide: () => noop()
});
