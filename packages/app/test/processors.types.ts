// Compile-time tests (never executed): what Crablet.processors and Crablet.catalog need is read off the modules declared, and a declaration that cannot
// work does not compile.
import type { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import type { CommandExecutor } from "@crablet/commands";
import type { EventStore } from "@crablet/eventstore";
import type { Processors } from "@crablet/modules/Processors";
import * as Views from "@crablet/views";
import * as Automations from "@crablet/automations";
import * as Outbox from "@crablet/outbox";
import * as Deadlines from "@crablet/deadlines";
import type { OutboxPublisher, OutboxPublishers } from "@crablet/outbox/OutboxPublisher";
import { defineTopic } from "@crablet/outbox/TopicConfig";
import * as Crablet from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Needs<L> = L extends Layer.Layer<Processors, never, infer R> ? R : "not a Processors layer that cannot fail";

const topics = [defineTopic("orders", { publishers: ["kafka"] })];
const all = Crablet.modules(Views.module({ views: [] }))
  .with(Automations.module({ automations: [] }))
  .with(Outbox.module({ topics }))
  .with(Deadlines.module({ commands: [] }));
const viewsOnly = Crablet.modules(Views.module({ views: [] }));

// A catalog runs nothing: it needs the SQL client only, whatever the modules (decision V1).
export const catalogOfAll = Crablet.catalog(all);
export const catalogOfAllNeeds: Equal<Needs<typeof catalogOfAll>, SqlClient.SqlClient> = true;

// Running needs what each module's run needs: the executor only because automations and deadlines run commands, the publishers only because of the outbox.
export const processorsOfAll = Crablet.processors(all);
export const processorsOfAllNeed: Equal<Needs<typeof processorsOfAll>, SqlClient.SqlClient | PgClient.PgClient | CommandExecutor | EventStore | OutboxPublishers> = true;
export const viewsProcessors = Crablet.processors(viewsOnly);
export const anAppOfViewsNeedsNoExecutor: Equal<Needs<typeof viewsProcessors>, SqlClient.SqlClient | PgClient.PgClient> = true;

declare const kafka: OutboxPublisher;
export const checks = () => {
  // `run` names declared kinds only
  Crablet.processors(all, { run: ["views", "outbox"] });
  // @ts-expect-error "automations" is no module of this declaration
  Crablet.processors(viewsOnly, { run: ["automations"] });

  // @ts-expect-error two modules of one kind
  Crablet.modules(Views.module({ views: [] })).with(Views.module({ views: [] }));

  // the outbox's publishers, one per name its topics give
  Outbox.publishers(topics, { kafka });
  // @ts-expect-error a name with no publisher
  Outbox.publishers(topics, {});
};
