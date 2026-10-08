import { Duration, Effect, Metric } from "effect";
import * as PollerMetrics from "@crablet/metrics-otel/PollerMetrics";
import type { ProcessorManagementService } from "./ProcessorManagementService.ts";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import { defaultInstanceId } from "./InstanceId.ts";

// What the sampler reads about one processor.
export interface ProcessorSample {
  readonly processor: string;
  readonly status: ProcessorStatus;
  readonly cursorPosition: bigint | null;
  readonly lagEvents: number | null;
  readonly lagSeconds: number | null;
}

const STATUSES: ReadonlyArray<ProcessorStatus> = ["ACTIVE", "PAUSED", "FAILED"];

// Reads every processor this process runs, through `service` (views, automations or outbox). A processor whose backlog cannot be read
// is still reported with its status; the rest of the fields are null and the gauges for them are left as they were.
export const sampleProcessors = (service: ProcessorManagementService<string>): Effect.Effect<ReadonlyArray<ProcessorSample>> =>
  Effect.gen(function* () {
    const statuses = yield* Effect.catch(service.getAllStatuses, (error) =>
      Effect.as(Effect.logWarning(`processor statuses unreadable: ${String(error)}`), new Map<string, ProcessorStatus>())
    );
    const samples: Array<ProcessorSample> = [];
    for (const [processor, status] of statuses) {
      const backlog = yield* Effect.catch(service.getBacklog(processor), (error) =>
        Effect.as(Effect.logWarning(`processor ${processor}: backlog unreadable: ${String(error)}`), null)
      );
      samples.push({
        processor,
        status,
        cursorPosition: backlog?.cursor.position ?? null,
        lagEvents: backlog?.pendingEvents ?? null,
        lagSeconds: backlog === null ? null : backlog.oldestPendingSeconds ?? 0
      });
    }
    return samples;
  });

// Sets the gauges from samples.
export const recordProcessorSamples = (samples: ReadonlyArray<ProcessorSample>, instanceId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const sample of samples) {
      const tags = { processor: sample.processor, instance_id: instanceId };
      for (const status of STATUSES) {
        yield* Metric.update(Metric.withAttributes(PollerMetrics.status, { ...tags, status }), sample.status === status ? 1 : 0);
      }
      if (sample.cursorPosition !== null) yield* Metric.update(Metric.withAttributes(PollerMetrics.cursorPosition, tags), Number(sample.cursorPosition));
      if (sample.lagEvents !== null) yield* Metric.update(Metric.withAttributes(PollerMetrics.lagEvents, tags), sample.lagEvents);
      if (sample.lagSeconds !== null) yield* Metric.update(Metric.withAttributes(PollerMetrics.lagSeconds, tags), sample.lagSeconds);
    }
  });

// Keeps the gauges current: reads each service every `every` (default 15 seconds) for as long as the fiber lives, in every instance, so a processor whose leader
// has died still shows its lag growing. One failed read is logged and tried again later; it never fails the fiber. Pass the management services of
// the modules this process runs, e.g. `[views, automations, outbox]`.
export const monitorProcessors = (
  services: ReadonlyArray<ProcessorManagementService<string>>,
  options: { readonly every?: Duration.Input; readonly instanceId?: string } = {}
): Effect.Effect<never> => {
  const instanceId = options.instanceId ?? defaultInstanceId();
  const every = Duration.fromInputUnsafe(options.every ?? "15 seconds");
  return Effect.forever(
    Effect.forEach(services, (service) => sampleProcessors(service).pipe(Effect.flatMap((samples) => recordProcessorSamples(samples, instanceId)))).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`processor monitoring failed: ${String(cause)}`)),
      Effect.andThen(Effect.sleep(every))
    )
  );
};
