// The breaking-change classifier (scripts/openapi-breaking.ts), by the vocabulary of ADR-0013: each rule has a change that must be reported and one that must not.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { breakingChanges } from "./openapi-breaking.ts";

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

const created = { type: "object", properties: { status: { type: "string", enum: ["CREATED"] }, marker: { type: "string" }, note: { type: "string" } }, required: ["status", "marker"] };
const problem = { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] };
const input = { type: "object", properties: { studentId: { type: "string" }, courseId: { type: "string" }, seats: { type: "integer", minimum: 1, maximum: 10 } }, required: ["studentId", "courseId"] };

const base = (): Json => ({
  openapi: "3.1.0",
  paths: {
    "/api/commands/subscribe": {
      post: {
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Input" } } } },
        responses: {
          "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Created" } } } },
          "400": { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } }
        }
      }
    },
    "/api/courses/{courseId}": {
      get: {
        parameters: [
          { name: "courseId", in: "path", required: true, schema: { type: "string" } },
          { name: "consistentWith", in: "query", required: false, schema: { type: "string" } }
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Created" } } } } } }
      }
    }
  },
  components: { schemas: { Input: clone(input), Created: clone(created), Problem: clone(problem) } }
});

// the change `edit` makes to a copy of the base, as the classifier sees it
const change = (edit: (doc: any) => void): ReadonlyArray<string> => {
  const after = base();
  edit(after);
  return breakingChanges(base(), after);
};
const schemas = (doc: any) => doc.components.schemas;
const post = (doc: any) => doc.paths["/api/commands/subscribe"].post;

describe("what is breaking (ADR-0013)", () => {
  test("an unchanged description has no breaking change", () => {
    expect(breakingChanges(base(), base())).toEqual([]);
  });

  test("a route, an answer, a response content type or a response field that is gone", () => {
    expect(change((d) => delete d.paths["/api/commands/subscribe"])).toEqual(["POST /api/commands/subscribe: route removed"]);
    expect(change((d) => delete post(d).responses["400"])).toEqual(["POST /api/commands/subscribe: answer 400 removed"]);
    expect(change((d) => { post(d).responses["400"].content = {}; })).toEqual(["POST /api/commands/subscribe 400: content type application/problem+json removed"]);
    expect(change((d) => delete schemas(d).Created.properties.marker)).toContain('POST /api/commands/subscribe 201: field "marker" removed');
  });

  test("a response field retyped, or no longer always present", () => {
    // `Created` is the answer of two operations, so both are reported
    expect(change((d) => { schemas(d).Created.properties.marker = { type: "number" }; })).toEqual([
      'POST /api/commands/subscribe 201.marker: type changed from "string" to "number"',
      'GET /api/courses/{courseId} 200[].marker: type changed from "string" to "number"'
    ]);
    expect(change((d) => { schemas(d).Created.required = ["status"]; })).toEqual([
      'POST /api/commands/subscribe 201: field "marker" is no longer always present',
      'GET /api/courses/{courseId} 200[]: field "marker" is no longer always present'
    ]);
  });

  test("a response nested in an array, and a union, are read through", () => {
    expect(change((d) => delete schemas(d).Created.properties.note)).toContain('GET /api/courses/{courseId} 200[]: field "note" removed');
    const withUnion = (variants: ReadonlyArray<unknown>): Json => {
      const doc = base();
      post(doc).responses["400"].content["application/problem+json"].schema = { anyOf: variants };
      return doc;
    };
    const a = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
    const b = { type: "object", properties: { y: { type: "string" } }, required: ["y"] };
    expect(breakingChanges(withUnion([a, b]), withUnion([a, b]))).toEqual([]);
    expect(breakingChanges(withUnion([a, b]), withUnion([a])).length).toBe(1); // a possible problem was removed
    expect(breakingChanges(withUnion([a]), withUnion([a, b]))).toEqual([]); // a new declared problem is additive
  });

  test("a request: a new required field, parameter or body", () => {
    expect(change((d) => { schemas(d).Input.properties.reason = { type: "string" }; schemas(d).Input.required.push("reason"); })).toEqual([
      'POST /api/commands/subscribe request: new required field "reason"'
    ]);
    expect(change((d) => d.paths["/api/courses/{courseId}"].get.parameters.push({ name: "tenant", in: "query", required: true, schema: { type: "string" } }))).toEqual([
      "GET /api/courses/{courseId}: new required parameter query tenant"
    ]);
    expect(change((d) => { d.paths["/api/courses/{courseId}"].get.parameters[1].required = true; })).toEqual([
      "GET /api/courses/{courseId}: parameter query consistentWith is now required"
    ]);
    const optionalBody = base();
    post(optionalBody).requestBody.required = false;
    expect(breakingChanges(optionalBody, base())).toEqual(["POST /api/commands/subscribe: the request body is now required"]);
  });

  test("a request narrowed: a retyped field, a tighter bound, a changed pattern, a value no longer accepted", () => {
    expect(change((d) => { schemas(d).Input.properties.courseId = { type: "integer" }; })).toEqual([
      'POST /api/commands/subscribe request.courseId: type changed from "string" to "integer"'
    ]);
    expect(change((d) => { schemas(d).Input.properties.seats.maximum = 5; })).toEqual(["POST /api/commands/subscribe request.seats: maximum tightened to 5"]);
    expect(change((d) => { schemas(d).Input.properties.seats.minimum = 2; })).toEqual(["POST /api/commands/subscribe request.seats: minimum tightened to 2"]);
    expect(change((d) => { schemas(d).Input.properties.studentId.pattern = "^s-"; })).toEqual(["POST /api/commands/subscribe request.studentId: pattern changed"]);
    const wide = base();
    schemas(wide).Input.properties.kind = { type: "string", enum: ["a", "b"] };
    const narrow = clone(wide);
    schemas(narrow).Input.properties.kind.enum = ["a"];
    expect(breakingChanges(wide, narrow)).toEqual(['POST /api/commands/subscribe request.kind: value "b" is no longer accepted']);
    const closed = clone(base());
    schemas(closed).Input.additionalProperties = false;
    schemas(closed).Input.properties = { studentId: { type: "string" } };
    expect(breakingChanges(base(), closed).some((i) => i.includes('field "courseId" is no longer accepted'))).toBe(true);
  });
});

describe("what is additive (ADR-0013), and so not reported", () => {
  test("a new route, a new answer, a new optional request field, parameter or response field, a new response enum value", () => {
    expect(change((d) => { d.paths["/api/new"] = { get: { responses: { "200": {} } } }; })).toEqual([]);
    expect(change((d) => { post(d).responses["409"] = { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } }; })).toEqual([]);
    expect(change((d) => { schemas(d).Input.properties.reason = { type: "string" }; })).toEqual([]);
    expect(change((d) => d.paths["/api/courses/{courseId}"].get.parameters.push({ name: "page", in: "query", required: false, schema: { type: "integer" } }))).toEqual([]);
    expect(change((d) => { schemas(d).Created.properties.createdAt = { type: "string" }; })).toEqual([]);
    expect(change((d) => { schemas(d).Created.properties.status.enum.push("QUEUED"); })).toEqual([]);
  });

  test("a request that loosens: a bound relaxed, a field no longer required, an enum widened", () => {
    expect(change((d) => { schemas(d).Input.properties.seats.maximum = 20; schemas(d).Input.properties.seats.minimum = 0; })).toEqual([]);
    expect(change((d) => { schemas(d).Input.required = ["studentId"]; })).toEqual([]);
  });

  test("a $ref that points at itself ends", () => {
    const loop: Json = { openapi: "3.1.0", paths: { "/x": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } }, components: { schemas: { Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } } } } };
    expect(breakingChanges(loop, clone(loop))).toEqual([]);
  });
});

describe("the checked-in descriptions", () => {
  const root = path.resolve(import.meta.dir, "..");
  for (const file of ["wallet-openapi.json", "course-enrolment-openapi.json"]) {
    const doc = JSON.parse(readFileSync(path.join(root, "docs", "api", file), "utf8")) as any;

    test(`${file}: against itself there is no breaking change`, () => {
      expect(breakingChanges(doc, clone(doc))).toEqual([]);
    });

    test(`${file}: removing a command route, or a field of a command's answer, is reported (so the classifier reads the real documents)`, () => {
      const route = Object.keys(doc.paths).find((p) => doc.paths[p].post !== undefined)!;
      const withoutRoute = clone(doc);
      delete withoutRoute.paths[route];
      expect(breakingChanges(doc, withoutRoute)).toEqual([`POST ${route}: route removed`]);

      const withoutField = clone(doc);
      delete withoutField.components.schemas.CommandCreated.properties.marker;
      expect(breakingChanges(doc, withoutField).some((i) => i.includes('field "marker" removed'))).toBe(true);
    });

    test(`${file}: a new required field in a command's input is reported`, () => {
      const route = Object.keys(doc.paths).find((p) => doc.paths[p].post?.requestBody !== undefined)!;
      const after = clone(doc);
      const body = after.paths[route].post.requestBody.content["application/json"];
      body.schema = { type: "object", properties: { extra: { type: "string" } }, required: ["extra"] };
      expect(breakingChanges(doc, after).some((i) => i.includes('new required field "extra"'))).toBe(true);
    });
  }
});
