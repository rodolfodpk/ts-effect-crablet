// The two small pieces of GET /api/courses that are worth testing without a database.
import { describe, expect, test } from "bun:test";
import { likePrefix, parseLimit } from "../src/api/CourseQueryApiLive.ts";

describe("likePrefix: a SQL LIKE pattern for ids that START with the text", () => {
  test("appends the wildcard", () => {
    expect(likePrefix("math")).toBe("math%");
    expect(likePrefix("")).toBe("%");
  });

  test("escapes the characters LIKE treats specially, so they match literally", () => {
    expect(likePrefix("a_b")).toBe("a\\_b%");
    expect(likePrefix("100%")).toBe("100\\%%");
    expect(likePrefix("a\\b")).toBe("a\\\\b%");
    expect(likePrefix("%_\\")).toBe("\\%\\_\\\\%");
  });
});

describe("parseLimit", () => {
  test("absent means the default page size", () => {
    expect(parseLimit(undefined)).toBe(20);
  });

  test("whole numbers from 1 to 100 are accepted", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
    expect(parseLimit("007")).toBe(7);
  });

  test.each(["0", "101", "-1", "1.5", "abc", "", " 5", "5 ", "1e2", "０５"])("%p is refused", (raw) => {
    expect(parseLimit(raw)).toBeNull();
  });
});
