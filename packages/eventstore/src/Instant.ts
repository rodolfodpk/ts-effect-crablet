import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// An instant in a payload, a command's input or a response: stored and sent as ISO-8601 text in UTC, read as an Effect `DateTime.Utc`. Text that is not
// an instant fails to decode, loudly, and the type checker refuses a plain string where an `Instant` is declared.
//
//     schema: Schema.Struct({ courseId: Schema.String, subscribedAt: Instant })
//     DateTime.add(data.subscribedAt, { days: 3 })
//
// It is `Schema.DateTimeUtcFromString` with `format: "date-time"` on the text side, which is the side an OpenAPI description is generated from (an
// annotation on the outside of the transformation does not reach it), so clients generated from the description get a date type. It imports only
// Effect, so a contract or an API declaration a browser imports can use it.
export const Instant = Schema.String.annotate({ expected: "an ISO-8601 instant in UTC", format: "date-time" }).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString)
);
