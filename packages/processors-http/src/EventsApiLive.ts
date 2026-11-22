import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventStore, type StoredEvent } from "@crablet/eventstore";
import * as Cursor from "@crablet/eventstore/Cursor";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { adminApi } from "./AdminApi.ts";
import { EventsBadRequest, MAX_PAGE, type EventPage, type LoggedEvent } from "./EventsApi.ts";

export interface EventsQueryParams {
  readonly types?: string;
  readonly tag?: string | ReadonlyArray<string>;
  readonly after?: string;
  readonly limit?: string;
}

// What to show of a payload: the value to show, or undefined to withhold it. Build it from the application's event definitions with
// `eventPayloadMask(definitions)` (@crablet/commands/Personal): personal fields redacted, unknown keys dropped, a type with no definition withheld.
export type PayloadMask = (type: string, data: unknown) => unknown;

// What to show of an event's metadata (ADR-0051): the value to show, or undefined to withhold it. Metadata has no schema to mark personal data with, so
// it is withheld unless the application says what of it may be shown.
export type MetadataMask = (type: string, metadata: Readonly<Record<string, unknown>>) => unknown;

export interface Masks {
  readonly mask?: PayloadMask;
  readonly metadataMask?: MetadataMask;
}

// Without a mask, no payload is shown.
const withholdAll: PayloadMask = () => undefined;

const loggedEvent = (e: StoredEvent, masks: Masks): LoggedEvent => {
  const shown = (masks.mask ?? withholdAll)(e.type, e.data);
  const meta = e.metadata === undefined || masks.metadataMask === undefined ? undefined : masks.metadataMask(e.type, e.metadata);
  return {
    eventId: e.eventId,
    type: e.type,
    tags: e.tags.map((t) => ({ key: t.key, value: t.value })),
    position: e.position.toString(),
    transactionId: e.transactionId,
    occurredAt: e.occurredAt.toISOString(),
    correlationId: e.correlationId,
    causationId: e.causationId === null ? null : e.causationId.toString(),
    data: shown === undefined ? null : shown,
    dataShown: shown !== undefined,
    metadata: meta === undefined ? null : meta,
    metadataShown: e.metadata === undefined || meta !== undefined
  };
};

// One page of the log for these query parameters: types and tags make one query item (any of the types, all of the tags); neither, every event.
export const listEvents = (params: EventsQueryParams, masks: Masks = {}): Effect.Effect<EventPage, EventsBadRequest, EventStore> =>
  Effect.gen(function* () {
    const types = (params.types ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    const rawTags = params.tag === undefined ? [] : typeof params.tag === "string" ? [params.tag] : params.tag;
    const tags: Array<Tag.Tag> = [];
    for (const raw of rawTags) {
      const at = raw.indexOf("=");
      if (at <= 0) return yield* Effect.fail(EventsBadRequest.of(`a tag is key=value, got ${JSON.stringify(raw)}`));
      tags.push(Tag.of(raw.slice(0, at), raw.slice(at + 1)));
    }
    const limit = params.limit === undefined ? 100 : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return yield* Effect.fail(EventsBadRequest.of(`limit is a whole number from 1 to ${MAX_PAGE}, got ${params.limit}`));
    let after: Cursor.Cursor | undefined;
    if (params.after !== undefined) {
      try {
        after = Cursor.fromString(params.after);
      } catch {
        return yield* Effect.fail(EventsBadRequest.of(`after is the cursor of a previous page, got ${JSON.stringify(params.after)}`));
      }
    }
    const query = types.length === 0 && tags.length === 0 ? Query.all() : Query.of(Query.queryItemOf(types, tags));
    const es = yield* EventStore;
    const page = yield* es.read(query, { limit, ...(after === undefined ? {} : { after }) }).pipe(Effect.orDie);
    return { events: page.events.map((e) => loggedEvent(e, masks)), cursor: Cursor.toString(page.cursor), more: page.more };
  });

// The handler of `eventsGroup`, typed by its endpoint (`HttpApiBuilder.handler`): its query, success and error types come from it, and it needs the
// EventStore. `mask` decides what of a payload is shown, `metadataMask` what of the metadata (none without). `adminApiLayer` (AdminApiLive.ts)
// registers it; an application that puts the group in an API of its own registers it there.
export const eventsHandler = (masks: Masks = {}) => HttpApiBuilder.handler(adminApi, "events", "listEvents", ({ query }) => listEvents(query, masks));
