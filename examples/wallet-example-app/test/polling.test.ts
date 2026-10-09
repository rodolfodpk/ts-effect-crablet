import { describe, expect, test } from "bun:test";
import { defaultPolling, pollingFromEnv, wakeupModeFromEnv } from "../src/polling.ts";

describe("WALLET_POLL_MS and WALLET_BACKOFF_MAX_SECONDS", () => {
  test("unset or blank means today's defaults (1 s, 120 s)", () => {
    expect(pollingFromEnv({})).toEqual(defaultPolling);
    expect(pollingFromEnv({ WALLET_POLL_MS: " ", WALLET_BACKOFF_MAX_SECONDS: "" })).toEqual({ pollingIntervalMs: 1000, backoffMaxSeconds: 120 });
  });
  test("whole numbers set them", () => {
    expect(pollingFromEnv({ WALLET_POLL_MS: "5000", WALLET_BACKOFF_MAX_SECONDS: "10" })).toEqual({ pollingIntervalMs: 5000, backoffMaxSeconds: 10 });
  });
  test("anything else stops the start-up with a message that names the variable and the value", () => {
    expect(() => pollingFromEnv({ WALLET_POLL_MS: "10" })).toThrow('WALLET_POLL_MS must be a whole number of 50 or more, got "10"');
    expect(() => pollingFromEnv({ WALLET_POLL_MS: "1.5s" })).toThrow('WALLET_POLL_MS must be a whole number of 50 or more, got "1.5s"');
    expect(() => pollingFromEnv({ WALLET_BACKOFF_MAX_SECONDS: "0" })).toThrow('WALLET_BACKOFF_MAX_SECONDS must be a whole number of 1 or more, got "0"');
  });
});

describe("WALLET_WAKEUPS", () => {
  test("unset is coalesced; the three modes are accepted; anything else stops the start-up", () => {
    expect(wakeupModeFromEnv(undefined)).toBe("coalesced");
    expect(wakeupModeFromEnv(" off ")).toBe("off");
    expect(wakeupModeFromEnv("inline")).toBe("inline");
    expect(() => wakeupModeFromEnv("never")).toThrow('WALLET_WAKEUPS must be coalesced, inline or off, got "never"');
  });
});
