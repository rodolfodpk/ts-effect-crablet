// Port of com.crablet.eventpoller.progress.ProcessorStatus. A plain string-literal union - matches
// the `status` TEXT column (CHECK-constrained to these three values) directly, no encode/decode step.
//
// PATTERN NOTE: a string-literal union (`"ACTIVE" | "PAUSED" | "FAILED"`) is TypeScript's
// lightest-weight enum equivalent - unlike TS's own `enum` keyword (which generates a runtime
// object) or a Java `enum` (a real class with instances), this is a *type-only* construct: it
// exists purely for the compiler, compiles away to nothing, and the runtime value is just the
// plain string itself. That's exactly what's wanted here - the value flows straight in and out of
// a Postgres TEXT column with no translation step, and `switch`/`===` comparisons against it work
// exactly like comparing plain strings, because that's all they are.
export type ProcessorStatus = "ACTIVE" | "PAUSED" | "FAILED";
