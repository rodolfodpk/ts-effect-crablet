// The server side of a consistent read (ADR-0015): the wrapper a read handler goes through (`makeConsistentRead`) and the settings it applies, for the
// whole API and per endpoint (`ReadConsistencyConfig`, `defaultReadConsistency`). What an endpoint declares is `./ReadsApi`.
export * from "./ConsistentRead.ts";
export * from "./ReadConsistency.ts";
