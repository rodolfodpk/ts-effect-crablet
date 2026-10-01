import * as Schema from "effect/Schema";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { hasPersonalData, personalValues } from "./Personal.ts";

// An event definition is the single source of truth for one kind of event: its type name, its
// payload schema, which tags it carries, and how to query for it. Command handlers, models and
// idempotency checks all go through it, so a type string or a tag key is never retyped (and a typo
// in one is a compile error, not a silent "matches nothing").
//
//     export const DepositMade = defineEvent("DepositMade", {
//       schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String, amount: Schema.Number }),
//       tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
//     });
//
//     DepositMade({ walletId: "w1", depositId: "d1", amount: 10 })   // -> AppendEvent with both tags
//     DepositMade.where({ deposit_id: "d1" })                        // -> Query; unknown tag keys don't compile
//
// A tag value may be a LIST: one tag per distinct element, same key. For an event that concerns many
// entities at once (each extra tag is one more append lock, so keep such lists modest):
//
//     tags: (d) => ({ product_id: d.items.map((i) => i.productId) })   // -> product_id=p1, product_id=p2
//
// PATTERN PRIMER - a function with properties: `EventDef` below has a *call signature* (you call it
// to build an event) AND properties (`type`, `decode`, `where`). TypeScript models this directly; at
// runtime it is a plain function with extra fields attached via `Object.assign`.

type TagValue = string | number;

export interface EventDef<Type extends string, Data, TagKeys extends string> {
  // Build the event to append. `extraTags` are added after the tags derived from the payload - for
  // tags that are scoping context rather than part of the event's own data (e.g. a period).
  (data: Data, extraTags?: ReadonlyArray<Tag.Tag>): AppendEvent.AppendEvent;
  readonly type: Type;
  // The payload schema (what the event log API documents, and what personal-data handling reads: see Personal.ts).
  readonly schema: Schema.Constraint;
  // Validate and narrow a stored event's raw JSON payload. Throws if the stored data does not match
  // the schema (a defect: the log contains something this definition cannot read).
  readonly decode: (raw: unknown) => Data;
  // Query for events of this type, optionally restricted to events carrying these tag values.
  // Only tag keys this event declares are accepted.
  readonly where: (filter?: { readonly [K in TagKeys]?: TagValue }) => Query.Query;
}

export const defineEvent = <
  Type extends string,
  S extends Schema.Constraint,
  T extends Record<string, TagValue | ReadonlyArray<TagValue> | null | undefined>
>(
  type: Type,
  def: { readonly schema: S; readonly tags: (data: Schema.Schema.Type<S>) => T }
): EventDef<Type, Schema.Schema.Type<S>, Extract<keyof T, string>> => {
  const decode = Schema.decodeUnknownSync(def.schema as never) as (raw: unknown) => Schema.Schema.Type<S>;

  const hasPersonal = hasPersonalData(def.schema as never);

  // Tags are stored as plain, indexed text and can never be encrypted or redacted: personal data must not be in one.
  // When the payload marks fields `personal(...)`, building the event fails (a defect, caught in tests) if any tag value
  // equals one of them (compared trimmed and lower-cased, because tags are lower-cased). It catches direct reuse only: a
  // value derived from a personal field (a hash, an opaque id) is exactly what a tag SHOULD use, and is not detected.
  const guardTags = (data: Schema.Schema.Type<S>, tags: ReadonlyArray<Tag.Tag>): void => {
    if (!hasPersonal) return;
    const personalSet = new Set(personalValues(def.schema as never, data));
    for (const tag of tags) {
      if (personalSet.has(tag.value.trim().toLowerCase())) {
        throw new Error(
          `event "${type}": the tag "${tag.key}" carries a value that is also in a field marked personal(...). Tags are stored as plain indexed text and cannot be erased or redacted: tag an opaque id (or a hash) instead.`
        );
      }
    }
  };

  const build = (data: Schema.Schema.Type<S>, extraTags: ReadonlyArray<Tag.Tag> = []) => {
    const builder = AppendEvent.builder(type);
    // `tag` lower-cases the key and skips null/undefined values. A list value becomes one tag per
    // distinct element (same key repeated), e.g. an order touching several products.
    for (const [key, value] of Object.entries(def.tags(data))) {
      const values: ReadonlyArray<TagValue | null | undefined> = Array.isArray(value)
        ? [...new Set((value as ReadonlyArray<TagValue>).map(String))]
        : [value as TagValue | null | undefined];
      for (const one of values) builder.tag(key, one);
    }
    const built = builder.tags(extraTags).data(data).build();
    guardTags(data, built.tags);
    return built;
  };

  const where = (filter: Record<string, TagValue | undefined> = {}) =>
    Query.forEventAndTags(
      type,
      Object.entries(filter)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => Tag.of(key, String(value)))
    );

  return Object.assign(build, { type, schema: def.schema as Schema.Constraint, decode, where }) as EventDef<
    Type,
    Schema.Schema.Type<S>,
    Extract<keyof T, string>
  >;
};
