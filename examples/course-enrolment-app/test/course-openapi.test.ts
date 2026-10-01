// The course API's OpenAPI document (no server, no database): valid, complete, and identical to the copy checked in
// at docs/api/course-enrolment-openapi.json - so an API change shows up as a diff in review.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validate } from "@readme/openapi-parser";
import { inputJsonSchema, inputJsonSchemaProblems } from "@crablet/commands-http/InputJsonSchema";
import { courseOpenApiDocument, courseOpenApiFile } from "../src/api/CourseOpenApi.ts";
import { DefineCourse, Subscribe } from "../src/domain/Enrolment.ts";

const text = courseOpenApiDocument();
const spec = JSON.parse(text) as any;
const operation = (name: string) => spec.paths[`/api/commands/${name}`].post;

describe("course API OpenAPI document", () => {
  test("is a valid OpenAPI 3.1 document with a route per command", async () => {
    expect((await validate(structuredClone(spec))).valid).toBe(true);
    expect(spec.info.title).toBe("Course Enrolment API");
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/commands", "/api/commands/define_course", "/api/commands/subscribe"]);
  });

  test("request bodies are the commands' input schemas, constraints included", () => {
    const capacity = operation("define_course").requestBody.content["application/json"].schema.properties.capacity;
    expect(capacity).toEqual({ type: "integer", minimum: 1 });
    expect(operation("subscribe").requestBody.content["application/json"].schema.required).toEqual(["studentId", "courseId"]);
  });

  test("subscribe documents exactly its declared errors, typed with their own fields", () => {
    const statuses = Object.keys(operation("subscribe").responses).sort();
    expect(statuses).toEqual(["200", "201", "400", "404", "409", "500"]); // CourseNotFound 404; CourseFull / StudentAtLimit 409
    expect(Object.keys(spec.components.schemas.CourseFullProblem.properties.fields.properties).sort()).toEqual(["capacity", "courseId"]);
    expect(Object.keys(spec.components.schemas.StudentAtLimitProblem.properties.fields.properties).sort()).toEqual(["limit", "studentId"]);
  });

  test("define_course has no domain errors of its own (a repeat is the framework's 409)", () => {
    expect(Object.keys(operation("define_course").responses).sort()).toEqual(["200", "201", "400", "409", "500"]);
  });

  test("no input renders wrongly, and the document has no 'number or Infinity' fields", () => {
    expect([DefineCourse, Subscribe].flatMap((c) => inputJsonSchemaProblems(c))).toEqual([]);
    expect(text).not.toContain('"Infinity"');
    expect(JSON.stringify(inputJsonSchema(DefineCourse))).toContain('"minimum":1');
  });

  test("matches the copy checked in at docs/api/course-enrolment-openapi.json (regenerate: node scripts/generate-openapi.ts)", () => {
    expect(text).toBe(readFileSync(courseOpenApiFile, "utf8"));
  });
});
