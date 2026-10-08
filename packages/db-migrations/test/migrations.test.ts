import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { migrationFilePaths, migrationFiles as listedFiles, sqlDir } from "../src/index.ts";

const migrationFiles: ReadonlyArray<string> = listedFiles;

// The list is the only thing that says which files are migrations and in what order, so it has to match the directory exactly.
describe("migration list", () => {
  test("every listed file exists, and every .sql file in the directory is listed", () => {
    for (const file of migrationFiles) expect(existsSync(path.join(sqlDir, file)), file).toBe(true);
    expect([...migrationFiles].sort()).toEqual(readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort());
  });

  test("the files are numbered V1, V2, ... with no gap and no repeat, in that order", () => {
    const numbers = migrationFiles.map((f) => Number(/^V(\d+)__/u.exec(f)?.[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  test("migrationFilePaths gives the full path of each file, in the same order", () => {
    expect(migrationFilePaths()).toEqual(migrationFiles.map((f) => path.join(sqlDir, f)));
  });
});
