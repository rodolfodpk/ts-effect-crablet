import * as Schema from "effect/Schema";

// Input schemas shared by the wallet's commands.
export const Positive = Schema.Number.check(Schema.isGreaterThan(0));
export const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
// A string with at least one non-whitespace character.
export const NonBlank = Schema.String.check(Schema.isPattern(/\S/));
