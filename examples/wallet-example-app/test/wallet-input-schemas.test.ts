// The wallet's command inputs, as the API description will show them: every constraint reaches it, and none
// uses a schema that renders wrongly (see commands-http/src/InputJsonSchema.ts).
import { describe, expect, test } from "bun:test";
import { inputJsonSchema, inputJsonSchemaProblems } from "@crablet/commands-http/InputJsonSchema";
import { CloseWallet } from "../src/domain/commands/CloseWalletCommand.ts";
import { Deposit } from "../src/domain/commands/DepositCommand.ts";
import { OpenWallet } from "../src/domain/commands/OpenWalletCommand.ts";
import { TransferMoney } from "../src/domain/commands/TransferMoneyCommand.ts";
import { Withdraw } from "../src/domain/commands/WithdrawCommand.ts";

const commands = [OpenWallet, Deposit, Withdraw, TransferMoney, CloseWallet];

describe("wallet command inputs as JSON Schema", () => {
  test("no input uses a schema that renders wrongly", () => {
    expect(commands.flatMap((c) => inputJsonSchemaProblems(c))).toEqual([]);
  });

  test("a positive amount is documented as exclusiveMinimum 0", () => {
    for (const command of [Deposit, Withdraw, TransferMoney]) {
      expect(JSON.stringify(inputJsonSchema(command))).toContain('"exclusiveMinimum":0');
    }
  });

  test("an opening balance may be zero: minimum 0", () => {
    expect(JSON.stringify(inputJsonSchema(OpenWallet))).toContain('"minimum":0');
  });
});
