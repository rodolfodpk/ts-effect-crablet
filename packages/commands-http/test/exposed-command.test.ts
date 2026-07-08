import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as CD from "@crablet/commands/CommandDecision";
import { exposedCommandOf, type ExposedCommand } from "../src/ExposedCommand.ts";

interface OpenWalletCommand {
  readonly walletId: string;
}

const OpenWalletSchema = Schema.Struct({ walletId: Schema.String });

describe("exposedCommandOf", () => {
  test("bundles a schema and handler into one entry", () => {
    const handler = (_cmd: OpenWalletCommand) => Effect.succeed(CD.noOp());
    const entry = exposedCommandOf(OpenWalletSchema, handler);

    expect(entry.schema).toBe(OpenWalletSchema);
    expect(entry.handler).toBe(handler);
  });

  test("a map of entries supports lookup by commandType key", () => {
    const openWallet = exposedCommandOf(OpenWalletSchema, (_cmd: OpenWalletCommand) => Effect.succeed(CD.noOp()));
    // Registry is type-erased at this boundary - see ExposedCommand.ts's primer.
    const commands: Readonly<Record<string, ExposedCommand<any, any>>> = { open_wallet: openWallet };

    expect(commands["open_wallet"]).toBe(openWallet);
    expect(commands["unknown_command"]).toBeUndefined();
  });
});
