import { describe, expect, it } from "bun:test";
import { defaultReadConsistency, resolveReadPolicy, type ReadConsistencyConfig } from "../src/ReadConsistency.ts";

const ok = (resolution: ReturnType<typeof resolveReadPolicy>) => {
  if (!resolution.ok) throw new Error(`expected a policy, got: ${resolution.detail}`);
  return resolution.policy;
};
const invalid = (resolution: ReturnType<typeof resolveReadPolicy>) => {
  if (resolution.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(resolution.policy)}`);
  return resolution.detail;
};

describe("the defaults (ADR-0015: strict, and a read with no marker is a read of the head of the log)", () => {
  it("are strict, whenNoMarker latest, 5 s, at most 30 s, no relaxing", () => {
    expect(defaultReadConsistency).toEqual({ mode: "strict", whenNoMarker: "latest", timeoutMs: 5000, maxTimeoutMs: 30000, clientMayRelax: false });
  });

  it("a request with no parameters waits for the head of the log, strictly", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, {}, {}))).toEqual({ mode: "strict", target: { _tag: "Latest" }, timeoutMs: 5000 });
  });
});

describe("the target of the wait", () => {
  it("is the marker the request carries", () => {
    const policy = ok(resolveReadPolicy(defaultReadConsistency, {}, { consistentWith: "7421:98213" }));
    expect(policy.target).toEqual({ _tag: "Marker", marker: { transactionId: "7421", position: 98213n } });
  });

  it("is the head of the log for consistentWith=latest", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, {}, { consistentWith: "latest" })).target).toEqual({ _tag: "Latest" });
  });

  it("with no marker follows whenNoMarker: none means no wait at all", () => {
    const config: ReadConsistencyConfig = { ...defaultReadConsistency, whenNoMarker: "none" };
    expect(ok(resolveReadPolicy(config, {}, {})).target).toEqual({ _tag: "None" });
    expect(ok(resolveReadPolicy(config, {}, { consistentWith: "latest" })).target).toEqual({ _tag: "Latest" }); // the client can still ask
  });

  it("is None under consistency=eventual, even with a marker (a read that does not wait)", () => {
    const config: ReadConsistencyConfig = { ...defaultReadConsistency, clientMayRelax: true };
    expect(ok(resolveReadPolicy(config, {}, { consistency: "eventual", consistentWith: "1:1" })).target).toEqual({ _tag: "None" });
    expect(ok(resolveReadPolicy(config, {}, { consistency: "eventual" })).target).toEqual({ _tag: "None" });
  });

  it("rejects a malformed marker, in every mode", () => {
    const config: ReadConsistencyConfig = { ...defaultReadConsistency, clientMayRelax: true };
    for (const raw of ["", "abc", "1", "1:", "latest ", "LATEST", "7:8:9", "-1:2", "007:1"]) {
      expect(invalid(resolveReadPolicy(config, {}, { consistentWith: raw })), JSON.stringify(raw)).toContain("consistentWith");
      expect(invalid(resolveReadPolicy(config, {}, { consistency: "eventual", consistentWith: raw })), JSON.stringify(raw)).toContain("consistentWith");
    }
  });
});

describe("the mode: a request can tighten the default, and loosen it only when the server allows", () => {
  const modes = ["strict", "bounded", "eventual"] as const;
  const rank = { strict: 2, bounded: 1, eventual: 0 } as const;

  for (const base of modes) {
    for (const requested of modes) {
      const loosens = rank[requested] < rank[base];
      it(`default ${base}, request ${requested}: ${loosens ? "refused unless clientMayRelax" : "allowed"}`, () => {
        const config: ReadConsistencyConfig = { ...defaultReadConsistency, mode: base };
        if (loosens) {
          expect(invalid(resolveReadPolicy(config, {}, { consistency: requested }))).toContain("not allowed");
          expect(ok(resolveReadPolicy({ ...config, clientMayRelax: true }, {}, { consistency: requested })).mode).toBe(requested);
        } else {
          expect(ok(resolveReadPolicy(config, {}, { consistency: requested })).mode).toBe(requested);
        }
      });
    }
  }

  it("a request that names no mode gets the default", () => {
    expect(ok(resolveReadPolicy({ ...defaultReadConsistency, mode: "bounded" }, {}, {})).mode).toBe("bounded");
  });

  it("rejects an unknown mode", () => {
    for (const raw of ["", "Strict", "weak", "latest"]) {
      expect(invalid(resolveReadPolicy({ ...defaultReadConsistency, clientMayRelax: true }, {}, { consistency: raw })), JSON.stringify(raw)).toContain("consistency must be one of");
    }
  });
});

describe("the endpoint's own settings override the API defaults, and the request is judged against the endpoint", () => {
  it("an endpoint can lower its default mode and its timeout", () => {
    const policy = ok(resolveReadPolicy(defaultReadConsistency, { mode: "bounded", timeoutMs: 800 }, {}));
    expect(policy.mode).toBe("bounded");
    expect(policy.timeoutMs).toBe(800);
  });

  it("an endpoint's whenNoMarker wins over the API's", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, { whenNoMarker: "none" }, {})).target).toEqual({ _tag: "None" });
  });

  it("clientMayRelax set on the endpoint lets that endpoint's clients loosen it", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, { clientMayRelax: true }, { consistency: "bounded" })).mode).toBe("bounded");
    expect(invalid(resolveReadPolicy(defaultReadConsistency, {}, { consistency: "bounded" }))).toContain("not allowed");
  });

  it("a request is compared with the ENDPOINT's mode: an endpoint that is bounded accepts a bounded request without clientMayRelax", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, { mode: "bounded" }, { consistency: "bounded" })).mode).toBe("bounded");
    expect(invalid(resolveReadPolicy(defaultReadConsistency, { mode: "bounded" }, { consistency: "eventual" }))).toContain("not allowed");
  });
});

describe("the timeout", () => {
  it("is the request's, when it is a whole number of milliseconds from 1 to the maximum", () => {
    expect(ok(resolveReadPolicy(defaultReadConsistency, {}, { waitTimeout: "1" })).timeoutMs).toBe(1);
    expect(ok(resolveReadPolicy(defaultReadConsistency, {}, { waitTimeout: "2500" })).timeoutMs).toBe(2500);
    expect(ok(resolveReadPolicy(defaultReadConsistency, {}, { waitTimeout: "30000" })).timeoutMs).toBe(30000);
  });

  it("rejects zero, above the maximum, negative, fractional and non-numeric values", () => {
    for (const raw of ["0", "30001", "-5", "1.5", "abc", "", " 5", "1e3"]) {
      expect(invalid(resolveReadPolicy(defaultReadConsistency, {}, { waitTimeout: raw })), JSON.stringify(raw)).toContain("waitTimeout must be a whole number");
    }
  });

  it("the maximum is the endpoint's if it sets one", () => {
    expect(invalid(resolveReadPolicy(defaultReadConsistency, { maxTimeoutMs: 1000 }, { waitTimeout: "1001" }))).toContain("1000");
    expect(ok(resolveReadPolicy(defaultReadConsistency, { maxTimeoutMs: 1000 }, { waitTimeout: "1000" })).timeoutMs).toBe(1000);
  });

  it("a configured default above the maximum is held to the maximum", () => {
    expect(ok(resolveReadPolicy({ ...defaultReadConsistency, timeoutMs: 90_000 }, {}, {})).timeoutMs).toBe(30_000);
  });

  it("is checked even in a mode that does not wait (a bad value is a bad request, not silently ignored)", () => {
    const config: ReadConsistencyConfig = { ...defaultReadConsistency, clientMayRelax: true };
    expect(invalid(resolveReadPolicy(config, {}, { consistency: "eventual", waitTimeout: "abc" }))).toContain("waitTimeout");
  });
});

describe("the first problem is the one reported", () => {
  it("a bad mode is reported before a bad timeout", () => {
    expect(invalid(resolveReadPolicy(defaultReadConsistency, {}, { consistency: "weak", waitTimeout: "abc" }))).toContain("consistency");
  });
});
