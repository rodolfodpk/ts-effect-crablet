// `@crablet/commands/Domain` is the one import of a domain file: what it gives is pinned here, so a declaration added to a narrower entry point and
// forgotten here, or a re-export dropped, fails a test (docs/reference/commands.md lists the same names).
import { describe, expect, test } from "bun:test";
import * as Domain from "../src/Domain.ts";
import * as Command from "../src/Command.ts";
import * as Tag from "@crablet/eventstore/Tag";

describe("@crablet/commands/Domain", () => {
  test("gives every declaration a domain file uses, and nothing else", () => {
    expect(Object.keys(Domain).sort()).toEqual(
      ["DomainError", "Instant", "Period", "Tag", "all", "byModel", "concurrent", "defineCommand", "defineContract", "defineEvent", "defineModel", "emit", "fail", "noop", "personal", "strict"].sort()
    );
  });

  test("they are the narrower entry points' own values, not copies", () => {
    expect(Domain.defineCommand).toBe(Command.defineCommand);
    expect(Domain.Tag.of).toBe(Tag.of);
  });
});
