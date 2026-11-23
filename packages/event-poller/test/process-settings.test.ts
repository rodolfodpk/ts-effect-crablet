import { describe, expect, test } from "bun:test";
import type { PollingSettings } from "../src/ProcessorConfig.ts";
import { pollingOver, withProcessSettings } from "../src/ProcessSettings.ts";

describe("pollingOver: the process's polling default with a module's own settings over it", () => {
  test("a module's setting wins over the process's", () => {
    expect(pollingOver({ pollingIntervalMs: 100, batchSize: 50 }, { pollingIntervalMs: 250 })).toEqual({ pollingIntervalMs: 250, batchSize: 50 });
  });

  test("a setting the module leaves undefined keeps the process's value (undefined means the default)", () => {
    expect(pollingOver({ pollingIntervalMs: 100 }, { pollingIntervalMs: undefined, maxErrors: undefined })).toEqual({ pollingIntervalMs: 100 });
  });

  test("with neither, nothing is set: the library defaults apply", () => {
    expect(pollingOver(undefined, undefined)).toEqual({});
  });
});

describe("withProcessSettings", () => {
  test("gives a module the process's instance id and leader settings, and keeps the module's own other settings", () => {
    // a module's config: the polling settings and its own (the outbox's publish timeout)
    const config: PollingSettings & { readonly publishTimeoutMs: number } = { pollingIntervalMs: undefined, publishTimeoutMs: 5 };
    const deps = withProcessSettings({ views: [], config }, { instanceId: "pod-1", polling: { pollingIntervalMs: 100 } });
    expect(deps).toEqual({ views: [], config: { pollingIntervalMs: 100, publishTimeoutMs: 5 }, instanceId: "pod-1", leader: undefined });
  });
});
