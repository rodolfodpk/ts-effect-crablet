// Pins the output of the README's runnable quick start (examples/quickstart/src/quickstart.ts), and checks that the README shows exactly that output.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/quickstart.ts";

const expected = [
  "ann -> math  created: StudentSubscribed",
  "bob -> math  failed: CourseFull",
  "ann -> math  idempotent: nothing appended",
  "ann -> art   created: StudentSubscribed",
  "ann -> bio   created: StudentSubscribed",
  "ann -> chem  failed: StudentAtLimit",
  "cy -> ghost  failed: CourseNotFound"
];

test("the quick start prints both rules at work: a full course, a repeat, a student at the limit, an unknown course", async () => {
  expect(await run()).toEqual(expected);
});

test("the README shows that output", () => {
  const readme = readFileSync(path.resolve(import.meta.dir, "../../../README.md"), "utf8");
  expect(readme).toContain("```\n" + expected.join("\n") + "\n```");
});
