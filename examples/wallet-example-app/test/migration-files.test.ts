import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appMigrationFiles } from "../src/migrate.ts";

// The app's migrations are applied from a list (`appMigrationFiles`: what the migrate job and the integration tests run), while the lab's Flyway job applies every V*.sql in the directory.
// A file that is in the directory and not in the list passes in the lab and is missing from the tests (or the migrate job), or the reverse: this fails on that, before anything runs.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migration");
const listed: ReadonlyArray<string> = appMigrationFiles;
const onDisk = readdirSync(dir).filter((f) => /^V\d+__.+\.sql$/.test(f)).sort();

describe("the app's migration files", () => {
  test("every V*.sql in db/migration is in appMigrationFiles, and every listed file exists", () => {
    expect([...listed].sort()).toEqual(onDisk);
  });

  test("the list is in version order, without a repeated version", () => {
    const versions = listed.map((f) => Number(/^V(\d+)__/.exec(f)![1]));
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("a file missing from the list would be found (the check can fail)", () => {
    expect([...listed.slice(0, -1)].sort()).not.toEqual(onDisk);
  });
});
