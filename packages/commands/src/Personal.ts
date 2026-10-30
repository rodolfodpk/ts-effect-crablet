import * as Schema from "effect/Schema";

// Marking personal data ONCE, in the schema, where it is declared (an event payload or a command input):
//
//     const Registered = defineEvent("Registered", {
//       schema: Schema.Struct({ userId: Schema.String, email: personal(Schema.String), plan: Schema.String }),
//       ...
//
// Everything that must treat personal data differently reads that one declaration: the command audit redacts it,
// the event log API masks it, the OpenAPI description flags it (`x-personal`), and a later crypto-shredding
// feature will encrypt it.
//
// HOW it is marked matters. `personal` is a NO-OP CHECK, not a schema annotation: in Effect an annotation added
// after `.check(...)` attaches to that last check instead of the field, so a walker looking at the field would miss
// it depending on the order the schema was written in. A check lives in the schema's list of checks, so it is found
// whichever order is used, survives composition (spread fields, `Struct`, `Array`, `NullOr`, `Record`,
// `optionalKey`), changes nothing about decoding, and emits `x-personal: true` into the generated JSON Schema by itself.
//
// Limits: `Schema.Class` is not walked (its schema is not a plain object node; use `Schema.Struct`, as events and
// command inputs already do). In a union, redaction is conservative (see `redact`).

export const PERSONAL_KEY = "crablet/personal";
export const REDACTED = "[redacted]";

export const personal = <S extends Schema.Top>(schema: S): S["Rebuild"] =>
  (schema as unknown as { check: (c: unknown) => S["Rebuild"] }).check(
    Schema.makeFilter(() => true, { [PERSONAL_KEY]: true, toJsonSchema: () => ({ "x-personal": true }) } as never)
  );

interface AstLike {
  readonly _tag: string;
  readonly checks?: ReadonlyArray<{ readonly annotations?: Record<string, unknown> }> | undefined;
}
// The nodes walked, by their tag: Effect's AST always gives them these lists (empty when there is nothing).
interface ObjectsAst extends AstLike {
  readonly propertySignatures: ReadonlyArray<{ readonly name: PropertyKey; readonly type: AstLike }>;
  readonly indexSignatures: ReadonlyArray<{ readonly type: AstLike }>;
}
interface ArraysAst extends AstLike {
  readonly elements: ReadonlyArray<AstLike>;
  readonly rest: ReadonlyArray<AstLike>;
}
interface UnionAst extends AstLike {
  readonly types: ReadonlyArray<AstLike>;
}

const astOf = (schema: Schema.Top): AstLike => (schema as unknown as { ast: AstLike }).ast;
const isMarked = (ast: AstLike): boolean => (ast.checks ?? []).some((c) => c.annotations?.[PERSONAL_KEY] === true);

// The paths of the fields marked personal: `email`, `address.street`, `phones.[]` (every element of an array),
// `notes.*` (every value of a record). A mark on the root itself is `(root)`.
export const personalPaths = (schema: Schema.Top): ReadonlyArray<string> => {
  const walk = (ast: AstLike, prefix: ReadonlyArray<string>): Array<string> => {
    const out: Array<string> = isMarked(ast) ? [prefix.join(".") || "(root)"] : [];
    switch (ast._tag) {
      case "Objects": {
        const { propertySignatures, indexSignatures } = ast as ObjectsAst;
        for (const p of propertySignatures) out.push(...walk(p.type, [...prefix, String(p.name)]));
        for (const i of indexSignatures) out.push(...walk(i.type, [...prefix, "*"]));
        break;
      }
      case "Arrays": {
        const { elements, rest } = ast as ArraysAst;
        elements.forEach((e, n) => out.push(...walk(e, [...prefix, String(n)])));
        for (const r of rest) out.push(...walk(r, [...prefix, "[]"]));
        break;
      }
      case "Union":
        for (const t of (ast as UnionAst).types) out.push(...walk(t, prefix));
        break;
      default:
        break;
    }
    return out;
  };
  return walk(astOf(schema), []);
};

export const hasPersonalData = (schema: Schema.Top): boolean => personalPaths(schema).length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A copy of `value` with every field the schema marks personal replaced by `replacement` ("[redacted]" by default).
// The input is never mutated. `null` and `undefined` are left as they are (there is nothing to protect, and
// "was it present?" is not secret); a marked object or array is replaced as a whole. A value with nothing to redact is
// returned as the SAME reference (copy-on-write), which is also what lets the union case below tell which member applied. Keys the schema does not know are
// left alone here: dropping them is the job of the caller that needs it (the event log API).
// In a union, each member is tried in turn on the value; a member that is itself marked redacts a non-null value, an object
// member redacts the keys it knows. This is conservative on purpose: unions of different shapes are the one case this
// cannot resolve exactly without decoding, so mark the fields of the shapes you use.
export const redact = (schema: Schema.Top, value: unknown, replacement: string = REDACTED): unknown => {
  const go = (ast: AstLike, v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (isMarked(ast)) return replacement;
    switch (ast._tag) {
      case "Objects": {
        if (!isRecord(v)) return v;
        const { propertySignatures, indexSignatures } = ast as ObjectsAst;
        const known = new Set(propertySignatures.map((p) => String(p.name)));
        let out: Record<string, unknown> | undefined;
        const set = (key: string, next: unknown) => {
          if (next !== v[key]) (out ??= { ...v })[key] = next;
        };
        // A missing key stays missing: `go` returns `undefined` for it, the value it already has, so `set` adds nothing.
        for (const p of propertySignatures) set(String(p.name), go(p.type, v[String(p.name)]));
        const index = indexSignatures[0];
        if (index !== undefined) for (const key of Object.keys(v)) if (!known.has(key)) set(key, go(index.type, v[key]));
        return out ?? v;
      }
      case "Arrays": {
        if (!Array.isArray(v)) return v;
        const { elements } = ast as ArraysAst;
        const rest = (ast as ArraysAst).rest[0];
        const mapped = v.map((item, n) => (n < elements.length ? go(elements[n]!, item) : rest !== undefined ? go(rest, item) : item));
        return mapped.some((item, n) => item !== v[n]) ? mapped : v;
      }
      case "Union": {
        for (const member of (ast as UnionAst).types) {
          const next = go(member, v);
          if (next !== v) return next;
        }
        return v;
      }
      default:
        return v;
    }
  };
  return go(astOf(schema), value);
};

// `value` as the event log may show it (ADR-0050): the fields marked personal redacted, and every key the schema does not know dropped, since such a
// key (a field an older version had) could hold personal data no current mark covers. A record (index signature) keeps its keys. In a union, the
// object member that keeps the most keys applies. The input is never mutated.
export const exposed = (schema: Schema.Top, value: unknown): unknown => {
  const keep = (ast: AstLike, v: unknown): unknown => {
    if (v === null || v === undefined || typeof v !== "object") return v;
    switch (ast._tag) {
      case "Objects": {
        if (!isRecord(v)) return v;
        const { propertySignatures, indexSignatures } = ast as ObjectsAst;
        const out: Record<string, unknown> = {};
        for (const p of propertySignatures) if (String(p.name) in v) out[String(p.name)] = keep(p.type, v[String(p.name)]);
        const index = indexSignatures[0];
        if (index !== undefined) for (const key of Object.keys(v)) if (!(key in out)) out[key] = keep(index.type, v[key]);
        return out;
      }
      case "Arrays": {
        if (!Array.isArray(v)) return v;
        const { elements } = ast as ArraysAst;
        const rest = (ast as ArraysAst).rest[0];
        return v.map((item, n) => (n < elements.length ? keep(elements[n]!, item) : rest !== undefined ? keep(rest, item) : item));
      }
      case "Union": {
        const kept = (ast as UnionAst).types.map((member) => keep(member, v));
        const size = (x: unknown) => (isRecord(x) ? Object.keys(x).length : Array.isArray(x) ? x.length : -1);
        return kept.reduce((best, x) => (size(x) > size(best) ? x : best), kept[0] ?? v);
      }
      default:
        return v;
    }
  };
  return keep(astOf(schema), redact(schema, value));
};

// For the event log API (processors-http's eventsGroup): what to show of an event's payload, from the application's event definitions
// (`defineEvent(...)` values). A type with a definition shows its payload `exposed`; a type with none shows nothing (undefined), since nothing
// says which of its fields are personal.
export const eventPayloadMask = (definitions: ReadonlyArray<{ readonly type: string; readonly schema: unknown }>) => {
  const byType = new Map(definitions.map((d) => [d.type, d.schema as Schema.Top] as const));
  return (type: string, data: unknown): unknown => {
    const schema = byType.get(type);
    return schema === undefined ? undefined : exposed(schema, data);
  };
};

// Every string / number found at the marked paths of `value`, normalised for comparison (trimmed, lower-cased). A marked
// object or array contributes every string and number inside it. Used by the tag guard (see Event.ts).
export const personalValues = (schema: Schema.Top, value: unknown): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string" || typeof v === "number") out.push(String(v).trim().toLowerCase());
    else if (Array.isArray(v)) v.forEach(collect);
    else if (isRecord(v)) Object.values(v).forEach(collect);
  };
  // `null` and `undefined` contribute nothing: `collect` takes neither, and neither is an array or an object to go into.
  const at = (v: unknown, path: ReadonlyArray<string>): void => {
    if (path.length === 0) return collect(v);
    const [head, ...tail] = path;
    if (head === "[]") (Array.isArray(v) ? v : []).forEach((item) => at(item, tail));
    else if (head === "*") (isRecord(v) ? Object.values(v) : []).forEach((item) => at(item, tail));
    // A field, or a tuple's position (`0`): an array is indexed like an object.
    else if (typeof v === "object" && v !== null) at((v as Record<string, unknown>)[head!], tail);
  };
  for (const path of personalPaths(schema)) at(value, path === "(root)" ? [] : path.split("."));
  return out;
};
