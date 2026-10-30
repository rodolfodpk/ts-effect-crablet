import type { Tag } from "./Tag.ts";

// How a tag is stored: the text `key=value` (crablet_events.tags is TEXT[]), with the key encoded so that the first `=` is always the separator. Any key
// and any value make the round trip exactly (the DCB specification leaves a tag's form to the client: the store must not misread it, ADR-0049).
//
// Only two characters of the key are encoded, `%` as `%25` and `=` as `%3D`; the value is stored as it is (everything after the first `=`). A key with
// neither, every key written before ADR-0049, is stored unchanged, so existing events, indexes and hand-written SQL keep their meaning. The SQL that
// splits a stored tag (`split_part(tag, '=', 1)`: crablet_event_tag_keys, the pollers' selection by key) gets the encoded key, which is what every
// query compares with, since they all encode through here.
//
// Every place that turns a tag into its stored text, or reads one back, goes through this file. Internal entry point (crablet.internal).

// The key as stored: what crablet_event_tag_keys holds and what a selection by key compares with.
export const encodeKey = (key: string): string => key.replaceAll("%", "%25").replaceAll("=", "%3D");

// Only `%25` and `%3D` are decoded; any other `%` is kept as it is.
export const decodeKey = (encoded: string): string => encoded.replace(/%25|%3D/g, (m) => (m === "%25" ? "%" : "="));

export const encode = (tag: Tag): string => `${encodeKey(tag.key)}=${tag.value}`;

// A stored tag back into its key and value. A stored text with no `=` (not written by this framework) is a key with an empty value.
export const decode = (stored: string): Tag => {
  const idx = stored.indexOf("=");
  return idx < 0 ? { key: decodeKey(stored), value: "" } : { key: decodeKey(stored.slice(0, idx)), value: stored.slice(idx + 1) };
};
