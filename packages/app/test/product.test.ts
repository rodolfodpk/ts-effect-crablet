// Decision V5: the process's identity names its connections `<product>/<instance>`; a product name is matched as the part before the "/".
import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import * as Crablet from "../src/index.ts";

const pg = { host: "localhost", port: 5432, database: "d", username: "u", password: Redacted.make("p") };

describe("the process's identity", () => {
  test("its connections are named <product>/<instance>", () => {
    expect(Crablet.applicationNameOf({ product: "wallet", instance: "pod-7" })).toBe("wallet/pod-7");
  });

  test("Crablet.layer refuses a product name that is blank or holds a slash, before anything connects", () => {
    expect(() => Crablet.layer(pg, { product: "wallet/eu" })).toThrow(/no "\/"/u);
    expect(() => Crablet.layer(pg, { product: " " })).toThrow(/non-empty/u);
    expect(() => Crablet.layer(pg, { product: "wallet" })).not.toThrow();
    expect(() => Crablet.layer(pg)).not.toThrow();
  });
});
