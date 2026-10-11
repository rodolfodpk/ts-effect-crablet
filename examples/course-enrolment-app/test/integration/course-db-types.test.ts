// Runs under Node (Testcontainers). The Kysely types of the view tables (src/views/db.generated.ts) are generated from the schema the migrations make: this fails when a migration changed a view table and the file was not regenerated
// (`npm run db:types` in examples/course-enrolment-app), so the types the queries are checked against cannot drift from the database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatedFile, generateDbTypes } from "../../scripts/db-types.ts";

describe("db.generated.ts", () => {
  it("is what the migrated schema generates", { timeout: 120_000 }, async () => {
    await generateDbTypes("verify");
  });

  it("is refused when it is not: a column that is not in the schema fails the check (the check can fail)", { timeout: 120_000 }, async () => {
    const stale = path.join(mkdtempSync(path.join(tmpdir(), "db-types-")), "db.generated.ts");
    writeFileSync(stale, readFileSync(generatedFile, "utf-8").replace("subscribers: Generated<number>;", "subscribers: Generated<number>;\n  seats_left: number;"));
    await assert.rejects(() => generateDbTypes("verify", stale));
  });
});
