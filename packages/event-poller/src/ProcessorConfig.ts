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

// PATTERN NOTE - `Omit<T, K>`/`Pick<T, K>`/`Partial<T>` are TypeScript's built-in "utility types":
// functions that take an existing type and produce a new, derived one, rather than writing the
// derived shape out by hand (and risking it drifting out of sync with `ProcessorConfig` itself).
// Read the two lines below as: `RequiredFields<I>` = "every ProcessorConfig field except
// processorId/maxErrors/leaderElectionRetryIntervalMs" (the ones without a Java-side default), and
// `DefaultedFields` = "just those two defaulted fields." `RequiredFields<I> &
// Partial<DefaultedFields>` (the parameter type below) then means "give me all the required
// fields, plus optionally either defaulted field" - if you add a new field to `ProcessorConfig`
// without a default, `RequiredFields<I>` picks it up automatically and callers are forced to
// supply it; add a new *defaulted* field and only `DefaultedFields` needs updating. This is the
// TS-generics way of keeping a "some fields required, some optional-with-defaults" factory
// function in sync with its target interface, in lieu of Java's default-method-on-interface trick.
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
