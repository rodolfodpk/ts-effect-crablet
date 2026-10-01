import * as Schema from "effect/Schema";

// Input schemas shared by the wallet's commands.
// Schema.Finite, not Schema.Number: the API document is generated from these schemas, and Schema.Number renders
// as "a number or the strings Infinity/-Infinity/NaN" and drops its checks, while Finite keeps them
// (exclusiveMinimum / minimum) and rejects non-finite values at the boundary.
export const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
export const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
// A string with at least one non-whitespace character.
export const NonBlank = Schema.String.check(Schema.isPattern(/\S/));
