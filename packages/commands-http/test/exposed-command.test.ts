import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { defineCommand, noop } from "@crablet/commands/Command";
import { exposedCommandOf, type ExposedCommand } from "../src/ExposedCommand.ts";

const OpenWallet = defineCommand({
  name: "open_wallet",
  input: Schema.Struct({ walletId: Schema.String }),
  decide: () => noop()
});

describe("exposedCommandOf", () => {
  test("wraps a defined command, with no error hook by default", () => {
    const entry = exposedCommandOf(OpenWallet);
    expect(entry.command).toBe(OpenWallet);
    expect(entry.mapError).toBeUndefined();
  });

  test("carries an optional hook that presents the command's own errors", () => {
    const hook = (_error: never) => ({ type: "problem" });
    expect(exposedCommandOf(OpenWallet, hook).mapError).toBe(hook);
  });

  test("a map of entries supports lookup by commandType key", () => {
    const openWallet = exposedCommandOf(OpenWallet);
    // The registry is type-erased at this boundary - see ExposedCommand.ts.
    const commands: Readonly<Record<string, ExposedCommand<any, any>>> = { open_wallet: openWallet };

    expect(commands["open_wallet"]).toBe(openWallet);
    expect(commands["unknown_command"]).toBeUndefined();
  });
});
