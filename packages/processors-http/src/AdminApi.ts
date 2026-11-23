import { HttpApi } from "effect/http-api";
import { eventsGroup } from "./EventsApi.ts";
import { processorsGroup } from "./ProcessorsApi.ts";

// The admin API: the processors (`processorsGroup`) and the event log (`eventsGroup`), one definition for the server that mounts it (`adminApiLayer`,
// AdminApiLive.ts) and for any client (`HttpApiClient.make(adminApi)`, as the processors-admin-ui page does). The description only: it imports nothing of
// the server, so a page bundled for a browser can import it. Being one concrete API is what lets the server register its groups fully typed; an
// application that would rather put the groups in an API of its own takes the typed handlers (`processorsHandlers`, `eventsHandler`) instead.
export const adminApi = HttpApi.make("crabletAdmin").add(processorsGroup).add(eventsGroup);
