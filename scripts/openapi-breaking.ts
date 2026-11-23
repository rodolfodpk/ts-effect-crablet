// Tells a BREAKING change of an OpenAPI description from an additive one, by the vocabulary of ADR-0013, for a client that is not TypeScript and so has no compiler to
// notice (docs/reference/http.md, "Two kinds of client"). The checked-in descriptions (docs/api/*.json) are compared byte for byte by a unit test, which says the API
// CHANGED; this says whether the change could break a client.
//
//     bun scripts/openapi-breaking.ts [baseRef]     # default origin/main: each docs/api/*.json there against the one in the working tree
//
// A snapshot regenerated in the same change always equals what the code generates, so only the comparison with the BASE can see a break. A break is allowed when a
// commit since the base ACKNOWLEDGES it: a line of its message that starts with `BREAKING:` or `BREAKING CHANGE:` (ADR-0013). The word in prose ("no breaking change")
// does not count. A base that cannot be read (an unknown or unfetched ref) is an error, not a pass. CI runs it on every pull request.
//
// What it calls breaking, from ADR-0013:
//   - a route (a path and method), an answer (a status), a response content type or a response field that is gone, or a response field's type that changed;
//   - a response field that was always present (`required`) and no longer is, or that may now be another shape (a union, `null`), because a client reads it;
//   - for a request: a new REQUIRED field, parameter or body; a field's type that changed; an enum value that is no longer accepted; a bound that tightened
//     (`minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`); a `pattern` that changed; a field that
//     was accepted and now is refused (`additionalProperties: false`).
// What it calls additive (and does not report): a new route, status, optional request field, response field or declared problem, and a new value of a response enum.
// Checks written through `allOf` (where Effect puts extra checks) are read as part of the schema. It does not judge what it cannot read from the description (a
// changed meaning behind the same shape): that is for review.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Obj = Readonly<Record<string, unknown>>;
const obj = (value: unknown): Obj | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const names = (value: unknown): ReadonlyArray<string> => list(value).filter((v): v is string => typeof v === "string");
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

// A schema, with its `$ref` followed (`#/components/schemas/<Name>`).
const resolve = (doc: Obj, schema: unknown): Obj | undefined => {
  let current = obj(schema);
  for (let hops = 0; current !== undefined && typeof current["$ref"] === "string" && hops < 20; hops++) {
    const name = String(current["$ref"]).replace("#/components/schemas/", "");
    current = obj(obj(obj(doc["components"])?.["schemas"])?.[name]);
  }
  return current;
};

// The strictest of two bounds of the same side.
const stricter = (field: string, a: unknown, b: unknown): unknown => {
  if (typeof a !== "number") return b;
  if (typeof b !== "number") return a;
  return field.startsWith("min") || field === "exclusiveMinimum" ? Math.max(a, b) : Math.min(a, b);
};
const boundFields = ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"] as const;

// A schema with its `$ref` followed and its `allOf` folded in: the properties of every part, the union of their `required`, the strictest of their bounds. A
// union (`anyOf`, `oneOf`) is kept as it is.
const flatten = (doc: Obj, schema: unknown, depth = 0): Obj | undefined => {
  const resolved = resolve(doc, schema);
  if (resolved === undefined || depth > 20) return resolved;
  const parts = list(resolved["allOf"]);
  if (parts.length === 0) return resolved;
  const merged: Record<string, unknown> = { ...resolved };
  delete merged["allOf"];
  for (const part of parts) {
    const p = flatten(doc, part, depth + 1);
    if (p === undefined) continue;
    for (const [key, value] of Object.entries(p)) {
      if (key === "properties") merged["properties"] = { ...(obj(merged["properties"]) ?? {}), ...(obj(value) ?? {}) };
      else if (key === "required") merged["required"] = [...new Set([...names(merged["required"]), ...names(value)])];
      else if ((boundFields as ReadonlyArray<string>).includes(key)) merged[key] = stricter(key, merged[key], value);
      else if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
};

const variantsOf = (schema: Obj): ReadonlyArray<unknown> => list(schema["anyOf"] ?? schema["oneOf"]);

interface Side { readonly doc: Obj }

// ---- a response: what the server sends, what a client reads ----
const responseIssues = (before: Side, after: Side, b: unknown, a: unknown, where: string, seen: Set<string>): ReadonlyArray<string> => {
  const sb = flatten(before.doc, b);
  if (sb === undefined) return [];
  const sa = flatten(after.doc, a);
  if (sa === undefined) return [`${where}: no longer described`];
  const key = `${JSON.stringify(sb)}|${JSON.stringify(sa)}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const variantsB = variantsOf(sb);
  const variantsA = variantsOf(sa);
  // a union before: every shape a client was told about is still among the answers (a declared problem removed is breaking; one added is additive)
  if (variantsB.length > 0) {
    const candidates = variantsA.length > 0 ? variantsA : [sa];
    return variantsB.flatMap((vb, i) =>
      candidates.some((va) => responseIssues(before, after, vb, va, where, new Set(seen)).length === 0) ? [] : [`${where}: possible answer #${i + 1} was removed or changed`]
    );
  }
  // one shape before, a union now: every shape the server may now send must read as the old one, or a client meets one it does not expect (`null`, say)
  if (variantsA.length > 0) {
    return variantsA.some((va) => responseIssues(before, after, sb, va, where, new Set(seen)).length > 0) ? [`${where}: may now answer a shape it did not (a union, or null)`] : [];
  }
  const issues: Array<string> = [];
  if (sb["type"] !== undefined && sa["type"] !== undefined && JSON.stringify(sb["type"]) !== JSON.stringify(sa["type"])) {
    return [`${where}: type changed from ${JSON.stringify(sb["type"])} to ${JSON.stringify(sa["type"])}`];
  }
  const propsB = obj(sb["properties"]) ?? {};
  const propsA = obj(sa["properties"]) ?? {};
  const requiredA = new Set(names(sa["required"]));
  const requiredB = new Set(names(sb["required"]));
  for (const field of Object.keys(propsB)) {
    if (!(field in propsA)) issues.push(`${where}: field "${field}" removed`);
    else {
      issues.push(...responseIssues(before, after, propsB[field], propsA[field], `${where}.${field}`, seen));
      if (requiredB.has(field) && !requiredA.has(field)) issues.push(`${where}: field "${field}" is no longer always present`);
    }
  }
  if (sb["items"] !== undefined) issues.push(...responseIssues(before, after, sb["items"], sa["items"], `${where}[]`, seen));
  return issues;
};

// ---- a request: what a client sends, what the server must still accept ----
interface Bound { readonly value: number; readonly exclusive: boolean }
// The lower or upper bound on a number (`minimum` / `exclusiveMinimum`, `maximum` / `exclusiveMaximum`), whichever is stricter.
const numericBound = (schema: Obj, side: "lower" | "upper"): Bound | undefined => {
  const inclusive = schema[side === "lower" ? "minimum" : "maximum"];
  const exclusive = schema[side === "lower" ? "exclusiveMinimum" : "exclusiveMaximum"];
  const candidates: Array<Bound> = [];
  if (typeof inclusive === "number") candidates.push({ value: inclusive, exclusive: false });
  if (typeof exclusive === "number") candidates.push({ value: exclusive, exclusive: true });
  if (candidates.length === 0) return undefined;
  return candidates.reduce((x, y) => (tighter(side, y, x) ? y : x));
};
// Is `a` a tighter bound than `b` (accepting fewer values)?
const tighter = (side: "lower" | "upper", a: Bound, b: Bound): boolean => {
  if (a.value !== b.value) return side === "lower" ? a.value > b.value : a.value < b.value;
  return a.exclusive && !b.exclusive;
};
const describeBound = (side: "lower" | "upper", bound: Bound): string =>
  `${side === "lower" ? (bound.exclusive ? "exclusiveMinimum" : "minimum") : bound.exclusive ? "exclusiveMaximum" : "maximum"} tightened to ${bound.value}`;
const lengthBounds = [
  ["minLength", "min"],
  ["minItems", "min"],
  ["maxLength", "max"],
  ["maxItems", "max"]
] as const;

const requestIssues = (before: Side, after: Side, b: unknown, a: unknown, where: string, seen: Set<string>): ReadonlyArray<string> => {
  const sb = flatten(before.doc, b);
  if (sb === undefined) return [];
  const sa = flatten(after.doc, a);
  if (sa === undefined) return [];
  const key = `${JSON.stringify(sb)}|${JSON.stringify(sa)}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const variantsB = variantsOf(sb);
  const variantsA = variantsOf(sa);
  // a union before: every form a client could send is still accepted by some form now
  if (variantsB.length > 0) {
    const candidates = variantsA.length > 0 ? variantsA : [sa];
    return variantsB.flatMap((vb, i) =>
      candidates.some((va) => requestIssues(before, after, vb, va, where, new Set(seen)).length === 0) ? [] : [`${where}: accepted form #${i + 1} is no longer accepted`]
    );
  }
  // one form before, a union now: a widening, fine as long as one of the forms still accepts the old one
  if (variantsA.length > 0) {
    return variantsA.some((va) => requestIssues(before, after, sb, va, where, new Set(seen)).length === 0) ? [] : [`${where}: the form it accepted is no longer accepted`];
  }
  if (sb["type"] !== undefined && sa["type"] !== undefined && JSON.stringify(sb["type"]) !== JSON.stringify(sa["type"])) {
    return [`${where}: type changed from ${JSON.stringify(sb["type"])} to ${JSON.stringify(sa["type"])}`];
  }
  const issues: Array<string> = [];
  const enumB = list(sb["enum"]);
  const enumA = list(sa["enum"]);
  if (enumA.length > 0) for (const value of enumB) if (!enumA.some((v) => JSON.stringify(v) === JSON.stringify(value))) issues.push(`${where}: value ${JSON.stringify(value)} is no longer accepted`);
  if (enumB.length === 0 && enumA.length > 0) issues.push(`${where}: now accepts only ${JSON.stringify(enumA)}`);
  for (const side of ["lower", "upper"] as const) {
    const bb = numericBound(sb, side);
    const ba = numericBound(sa, side);
    if (ba !== undefined && (bb === undefined || tighter(side, ba, bb))) issues.push(`${where}: ${describeBound(side, ba)}`);
  }
  for (const [field, side] of lengthBounds) {
    const vb = sb[field];
    const va = sa[field];
    if (typeof va !== "number") continue;
    if (typeof vb !== "number" || (side === "min" ? va > vb : va < vb)) issues.push(`${where}: ${field} tightened to ${va}`);
  }
  if (typeof sa["pattern"] === "string" && sa["pattern"] !== sb["pattern"]) issues.push(`${where}: pattern changed`);

  const propsB = obj(sb["properties"]) ?? {};
  const propsA = obj(sa["properties"]) ?? {};
  const requiredB = new Set(names(sb["required"]));
  for (const field of names(sa["required"])) if (!requiredB.has(field)) issues.push(`${where}: new required field "${field}"`);
  for (const field of Object.keys(propsB)) {
    if (field in propsA) issues.push(...requestIssues(before, after, propsB[field], propsA[field], `${where}.${field}`, seen));
    else if (sa["additionalProperties"] === false) issues.push(`${where}: field "${field}" is no longer accepted`);
  }
  if (sb["items"] !== undefined) issues.push(...requestIssues(before, after, sb["items"], sa["items"], `${where}[]`, seen));
  return issues;
};

const parametersOf = (operation: Obj): ReadonlyMap<string, Obj> =>
  new Map(list(operation["parameters"]).flatMap((p) => { const o = obj(p); return o === undefined ? [] : [[`${String(o["in"])} ${String(o["name"])}`, o] as const]; }));

const operationIssues = (before: Side, after: Side, b: Obj, a: Obj, where: string): ReadonlyArray<string> => {
  const issues: Array<string> = [];

  // parameters: a new required one breaks a client that does not send it; a changed one is judged as a request field
  const paramsB = parametersOf(b);
  for (const [name, pa] of parametersOf(a)) {
    const pb = paramsB.get(name);
    if (pb === undefined) {
      if (pa["required"] === true) issues.push(`${where}: new required parameter ${name}`);
    } else {
      issues.push(...requestIssues(before, after, pb["schema"], pa["schema"], `${where} parameter ${name}`, new Set()));
      if (pa["required"] === true && pb["required"] !== true) issues.push(`${where}: parameter ${name} is now required`);
    }
  }

  // the request body
  const bodyB = obj(b["requestBody"]);
  const bodyA = obj(a["requestBody"]);
  if (bodyA?.["required"] === true && bodyB?.["required"] !== true) issues.push(`${where}: the request body is now required`);
  if (bodyB !== undefined) {
    const contentA = obj(bodyA?.["content"]) ?? {};
    for (const [mime, mb] of Object.entries(obj(bodyB["content"]) ?? {})) {
      const ma = obj(contentA[mime]);
      if (ma === undefined) issues.push(`${where}: request content type ${mime} is no longer accepted`);
      else issues.push(...requestIssues(before, after, obj(mb)?.["schema"], ma["schema"], `${where} request`, new Set()));
    }
  }

  // the answers: every status that was declared is still, with every content type and every field
  const responsesA = obj(a["responses"]) ?? {};
  for (const [status, rb] of Object.entries(obj(b["responses"]) ?? {})) {
    const ra = obj(responsesA[status]);
    if (ra === undefined) {
      issues.push(`${where}: answer ${status} removed`);
      continue;
    }
    const contentA = obj(ra["content"]) ?? {};
    for (const [mime, mb] of Object.entries(obj(obj(rb)?.["content"]) ?? {})) {
      const ma = obj(contentA[mime]);
      if (ma === undefined) issues.push(`${where} ${status}: content type ${mime} removed`);
      else issues.push(...responseIssues(before, after, obj(mb)?.["schema"], ma["schema"], `${where} ${status}`, new Set()));
    }
  }
  return issues;
};

// The breaking differences between two descriptions, one line each; empty when the change is additive (or none).
export const breakingChanges = (before: unknown, after: unknown): ReadonlyArray<string> => {
  const docB = obj(before) ?? {};
  const docA = obj(after) ?? {};
  const issues: Array<string> = [];
  const pathsA = obj(docA["paths"]) ?? {};
  for (const [route, itemB] of Object.entries(obj(docB["paths"]) ?? {})) {
    const itemA = obj(pathsA[route]);
    for (const method of methods) {
      const operationB = obj(obj(itemB)?.[method]);
      if (operationB === undefined) continue;
      const where = `${method.toUpperCase()} ${route}`;
      const operationA = obj(itemA?.[method]);
      if (operationA === undefined) issues.push(`${where}: route removed`);
      else issues.push(...operationIssues({ doc: docB }, { doc: docA }, operationB, operationA, where));
    }
  }
  return issues;
};

// Do these commit messages acknowledge a break? Only a line that STARTS with `BREAKING:` or `BREAKING CHANGE:` does (the Conventional Commits footer), so "no
// breaking change" or a subject that mentions breaking changes does not.
export const acknowledgedIn = (messages: string): boolean => /^(BREAKING CHANGE|BREAKING):/mu.test(messages);

// ---- the command line: each docs/api/*.json at the base against the working tree ----
const git = (args: ReadonlyArray<string>): string => execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const succeeds = (args: ReadonlyArray<string>): boolean => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

if (import.meta.main) {
  const baseRef = process.argv[2] ?? "origin/main";
  // A base that cannot be read compares nothing: that must fail, or a missing fetch would pass every change.
  if (!succeeds(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])) {
    console.error(`${baseRef}: not a commit here (fetch it, or name another base); nothing was compared.`);
    process.exit(2);
  }
  const root = path.resolve(import.meta.dir, "..");
  const dir = path.join(root, "docs", "api");
  const found: Array<string> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    if (!succeeds(["cat-file", "-e", `${baseRef}:docs/api/${file}`])) {
      console.log(`${file}: not at ${baseRef} (a new description), nothing to compare`);
      continue;
    }
    const issues = breakingChanges(JSON.parse(git(["show", `${baseRef}:docs/api/${file}`])), JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    console.log(`${file}: ${issues.length === 0 ? "no breaking change" : `${issues.length} breaking`}`);
    found.push(...issues.map((i) => `  ${file}: ${i}`));
  }
  if (found.length > 0) {
    console.log(found.join("\n"));
    if (acknowledgedIn(git(["log", `${baseRef}..HEAD`, "--format=%B"]))) console.log(`\nA commit since ${baseRef} has a "BREAKING:" line: acknowledged (ADR-0013).`);
    else {
      console.log(
        `\nBreaking, and no commit since ${baseRef} acknowledges it. ADR-0013: a breaking change updates every consumer in the same commit, and its message has a line that starts with "BREAKING:" saying what breaks.`
      );
      process.exit(1);
    }
  }
}
