import { Option, Schema } from "effect";

// An opaque paging cursor: a key, as JSON, in base64url, so it is safe in a query string and means nothing to a client. One schema says what a
// cursor holds; decoding refuses anything this application did not make (null, which the endpoint answers with a 400, never a guess).
export interface OpaqueCursor<Key> {
  readonly encode: (key: Key) => string;
  readonly decode: (raw: string) => Key | null;
}

// `key`'s checks are what the SQL will cast each part to, so a forged or corrupted cursor is refused here and never reaches Postgres as a cast
// error (a 500). Text longer than `maxLength`, or with characters base64url does not use, is refused before it is decoded.
export const opaqueCursor = <Key>(key: Schema.Codec<Key, unknown>, maxLength: number): OpaqueCursor<Key> => {
  const wire = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(key)));
  const accepted = Schema.String.check(Schema.isMaxLength(maxLength), Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(Schema.decodeTo(wire));
  const encode = Schema.encodeSync(wire);
  const decode = Schema.decodeUnknownOption(accepted);
  return { encode: (k) => encode(k), decode: (raw) => Option.getOrNull(decode(raw)) };
};
