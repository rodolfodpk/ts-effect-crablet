// The wallet API's OpenAPI document (no server, no database): valid, complete, free of misleading schemas, and
// identical to the copy checked in at docs/api/wallet-openapi.json - so an API change shows up as a diff in review.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validate } from "@readme/openapi-parser";
import { walletOpenApiDocument, walletOpenApiFile } from "../src/api/WalletOpenApi.ts";

const text = walletOpenApiDocument();
const spec = JSON.parse(text) as any;

describe("wallet OpenAPI document", () => {
  test("is a valid OpenAPI 3.1 document", async () => {
    const result = await validate(structuredClone(spec));
    expect(result.valid).toBe(true);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Wallet API");
  });

  test("has a request body for every command and a read endpoint for each view", () => {
    for (const command of ["open_wallet", "deposit", "withdraw", "transfer_money", "close_wallet"]) {
      const operation = spec.paths[`/api/commands/${command}`].post;
      expect(operation.requestBody.content["application/json"].schema.type).toBe("object");
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["200", "201", "400", "409", "500"]));
    }
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/api/wallets/{walletId}", "/api/wallets/{walletId}/transactions", "/api/wallets/{walletId}/summary"])
    );
  });

  test("each declared domain error is documented where its command declares it, typed with its own fields", () => {
    const statuses = (command: string) => Object.keys(spec.paths[`/api/commands/${command}`].post.responses);
    expect(statuses("deposit")).toContain("404"); // WalletNotFound
    expect(statuses("withdraw")).toEqual(expect.arrayContaining(["404", "400"])); // + InsufficientFunds (kind invalid)
    expect(statuses("open_wallet")).not.toContain("404");

    const insufficient = spec.components.schemas.InsufficientFundsProblem;
    expect(Object.keys(insufficient.properties.fields.properties).sort()).toEqual(["currentBalance", "requestedAmount", "walletId"]);
  });

  test("personal data is flagged in the description: the owner's name is x-personal, balances and ids are not", () => {
    const props = spec.paths["/api/commands/open_wallet"].post.requestBody.content["application/json"].schema.properties;
    expect(JSON.stringify(props.owner)).toContain('"x-personal":true');
    expect(JSON.stringify(props.walletId)).not.toContain("x-personal");
    expect(JSON.stringify(props.initialBalance)).not.toContain("x-personal");
  });

  test("problems are application/problem+json", () => {
    const notFound = spec.paths["/api/commands/deposit"].post.responses["404"].content;
    expect(Object.keys(notFound)).toEqual(["application/problem+json"]);
  });

  test("nothing in the document is described as 'a number or Infinity/NaN' (Schema.Number): constraints must reach the description", () => {
    expect(text).not.toContain('"Infinity"');
    expect(spec.paths["/api/commands/deposit"].post.requestBody.content["application/json"].schema.properties.amount).toEqual({
      type: "number",
      exclusiveMinimum: 0
    });
  });

  test("matches the copy checked in at docs/api/wallet-openapi.json (run `bun run docs:api` after an API change)", () => {
    const checkedIn = readFileSync(walletOpenApiFile, "utf8");
    expect(text).toBe(checkedIn);
  });
});
