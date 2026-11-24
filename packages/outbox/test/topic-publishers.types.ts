// Compile-time tests (never executed): a topic names its publishers, and starting the outbox takes one publisher per name (ADR-0039, amended 2026-11-23).
import { startOutboxProcessor } from "../src/OutboxModule.ts";
import { defineTopic, type PublisherNamesOf, type TopicConfig } from "../src/TopicConfig.ts";
import type { OutboxPublisher } from "../src/OutboxPublisher.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const publisher: OutboxPublisher;
const orders = defineTopic("orders", { publishers: ["kafka", { publisher: "webhook", batchSize: 10 }] });
const payments = defineTopic("payments", { publishers: ["kafka"] });

export const namesAreRead: Equal<PublisherNamesOf<[typeof orders, typeof payments]>, "kafka" | "webhook"> = true;

export const starts = () => {
  // every name has its publisher
  startOutboxProcessor({ topics: [orders, payments], publishers: { kafka: publisher, webhook: publisher } });

  // @ts-expect-error a name with no publisher ("webhook")
  startOutboxProcessor({ topics: [orders, payments], publishers: { kafka: publisher } });

  // @ts-expect-error a publisher no topic names
  startOutboxProcessor({ topics: [payments], publishers: { kafka: publisher, sns: publisher } });

  // names widened to string: no record could be checked against them, so none compiles
  const widened: ReadonlyArray<TopicConfig> = [orders];
  // @ts-expect-error the names must be literal
  startOutboxProcessor({ topics: widened, publishers: {} });
  // @ts-expect-error the names must be literal
  startOutboxProcessor({ topics: widened, publishers: { kafka: publisher } });
};
