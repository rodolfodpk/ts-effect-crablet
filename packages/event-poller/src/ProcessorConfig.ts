// Port of com.crablet.eventpoller.processor.ProcessorConfig<I>. Java supplies maxErrors/
// leaderElectionRetryIntervalMs defaults via default methods; TS interfaces can't carry
// default-method bodies, so processorConfigOf() is the direct substitute (matching this repo's
// AppendEvent/Tag factory-with-defaults style).
export interface ProcessorConfig<I> {
  readonly processorId: I;
  readonly pollingIntervalMs: number;
  readonly batchSize: number;
  readonly backoffEnabled: boolean;
  readonly backoffThreshold: number;
  readonly backoffMultiplier: number;
  readonly backoffMaxSeconds: number;
  readonly maxErrors: number;
  readonly leaderElectionRetryIntervalMs: number;
  readonly enabled: boolean;
}

type RequiredFields<I> = Omit<ProcessorConfig<I>, "processorId" | "maxErrors" | "leaderElectionRetryIntervalMs">;
type DefaultedFields = Pick<ProcessorConfig<unknown>, "maxErrors" | "leaderElectionRetryIntervalMs">;

export const processorConfigOf = <I>(
  processorId: I,
  fields: RequiredFields<I> & Partial<DefaultedFields>
): ProcessorConfig<I> => ({
  processorId,
  maxErrors: 10,
  leaderElectionRetryIntervalMs: 30_000,
  ...fields
});
