// What a read endpoint and the live feed declare, safe for the browser: `consistencyQuery`, `ReadSuccess`, `readProblems` (./ReadsApi) and
// `liveFeedGroup`, `ViewAdvanced` (./LiveFeedApi). As `@crablet/commands-http`'s root is its API description, this root is the declarations only; the
// server side stays its own import (./ReadsLive, ./LiveFeedLive), so a page that imports the root bundles nothing that talks to the database.
export * from "./ReadsApi.ts";
export * from "./LiveFeedApi.ts";
