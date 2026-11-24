import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate, migrateApp, migrateIfFresh, problemsWith } from "../src/Migrate.ts";

const dir = mkdtempSync(path.join(tmpdir(), "crablet-app-migrations-"));
for (const f of ["V100__a.sql", "V101__b.sql", "V7__clash.sql", "V102__c.sql", "schema.sql"]) writeFileSync(path.join(dir, f), "SELECT 1;");
// No database listens here: a set that is refused must be refused before connecting.
const nowhere = { host: "127.0.0.1", port: 1, database: "none", username: "none", password: "none" };

describe("an application's migrations are checked before anything is applied", () => {
  test("a set numbered from V100, in order, every file present, has no problem", () => {
    expect(problemsWith({ dir, files: ["V100__a.sql", "V101__b.sql"] })).toEqual([]);
  });

  test("a file numbered below V100 would clash with the framework's", () => {
    expect(problemsWith({ dir, files: ["V7__clash.sql"] })).toEqual(['"V7__clash.sql" is numbered below V100, where the framework\'s migrations are']);
  });

  test("the files must be listed in increasing order", () => {
    expect(problemsWith({ dir, files: ["V101__b.sql", "V100__a.sql"] })).toEqual(['"V100__a.sql" comes after "V101__b.sql"']);
  });

  test("a file not named V<n>__<name>.sql, or missing, is a problem", () => {
    expect(problemsWith({ dir, files: ["schema.sql", "V103__missing.sql"] })).toEqual([
      '"schema.sql" is not named V<n>__<name>.sql',
      `"V103__missing.sql" is not in ${dir}`
    ]);
  });

  test("migrate, migrateIfFresh and migrateApp refuse such a set without connecting", async () => {
    await expect(migrate(nowhere, { dir, files: ["V7__clash.sql"] })).rejects.toThrow(/numbered below V100/);
    await expect(migrateIfFresh(nowhere, { dir, files: ["V101__b.sql", "V100__a.sql"] })).rejects.toThrow(/comes after/);
    await expect(migrateApp(nowhere, { dir, files: ["schema.sql"] })).rejects.toThrow(/is not named/);
  });
});
