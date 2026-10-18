import { describe, expect, test } from "bun:test";
import { withOverridesByName } from "../src/ProcessorRuntimeOverrides.ts";

type Item = { readonly name: string; readonly batchSize?: number | null; readonly pollingIntervalMs?: number | null };
const items: ReadonlyArray<Item> = [{ name: "a" }, { name: "b" }];

describe("withOverridesByName", () => {
  test("applies the overrides given by name, and leaves the others as they are", () => {
    const [a, b] = withOverridesByName("views", items, (i) => i.name, { b: { batchSize: 7, pollingIntervalMs: undefined } });
    expect(a).toEqual(items[0]!);
    expect(b).toEqual({ name: "b", batchSize: 7 });
  });

  test("refuses a name that is not in the list: a typo would otherwise be ignored", () => {
    expect(() => withOverridesByName("views", items, (i) => i.name, { c: { batchSize: 7 } })).toThrow(/views: overrides name "c", which is not in the list/);
  });
});
