import { Context } from "effect";
import type { LeaderSessions } from "../Leader.ts";
import type { SharedListens } from "../SharedListen.ts";

// The tag alone, so that Leader.ts and SharedListen.ts can read it without importing the layer that builds them (ProcessConnections.ts).
export class ProcessConnections extends Context.Service<
  ProcessConnections,
  { readonly leaders: LeaderSessions; readonly listens: SharedListens }
>()("@crablet/eventstore/ProcessConnections") {}
