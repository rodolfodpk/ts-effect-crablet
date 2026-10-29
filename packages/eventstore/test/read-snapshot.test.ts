// What a read could see (ADR-0048): the snapshot's text, and the intersection a command takes of several reads. The intersection is checked against
// the sets it stands for: an xid is seen by the intersection exactly when both snapshots see it. Postgres reading the same text, and the append's
// visibility test agreeing with pg_visible_in_snapshot, are in integration/read-snapshot.test.ts.
import { describe, expect, test } from "bun:test";
import * as ReadSnapshot from "../src/ReadSnapshot.ts";

const s = (text: string) => ReadSnapshot.fromText(text);

describe("ReadSnapshot", () => {
  test("reads pg_snapshot's text and nothing else", () => {
    expect(ReadSnapshot.parse(s("10:20:12,15"))).toEqual({ xmin: 10n, xmax: 20n, xip: [12n, 15n] });
    expect(ReadSnapshot.parse(s("10:10:"))).toEqual({ xmin: 10n, xmax: 10n, xip: [] });
    expect(() => ReadSnapshot.fromText("10:20")).toThrow();
    expect(() => ReadSnapshot.fromText("x:20:")).toThrow();
  });

  test("sees what had finished: below xmin, and between xmin and xmax unless running", () => {
    const snap = s("10:20:12,15");
    expect([9n, 10n, 11n, 12n, 13n, 15n, 19n, 20n, 25n].map((x) => ReadSnapshot.sees(snap, x))).toEqual([true, true, true, false, true, false, true, false, false]);
  });

  const cases: ReadonlyArray<readonly [string, string]> = [
    ["10:20:12,15", "10:20:12,15"],
    ["10:20:12,15", "14:30:14,22"],
    ["14:30:14,22", "10:20:12,15"],
    ["5:8:", "10:20:12"],
    ["10:20:", "3:40:3,18,35"],
    ["100:100:", "90:95:90,94"],
    ["7:12:7,9,11", "7:12:8,10"]
  ];
  for (const [a, b] of cases) {
    test(`intersect(${a}, ${b}) sees exactly what both see`, () => {
      const both = ReadSnapshot.intersect(s(a), s(b));
      for (let x = 0n; x < 120n; x++) {
        expect([x, ReadSnapshot.sees(both, x)]).toEqual([x, ReadSnapshot.sees(s(a), x) && ReadSnapshot.sees(s(b), x)]);
      }
      // a valid pg_snapshot: xmin <= every running xid < xmax, ascending, no repeats
      const { xmin, xmax, xip } = ReadSnapshot.parse(both);
      expect(xmin <= xmax).toBe(true);
      expect(xip.every((x, i) => x >= xmin && x < xmax && (i === 0 || xip[i - 1]! < x))).toBe(true);
    });
  }

  test("intersectAll: what every read saw, or nothing to refine with when one read carried no snapshot", () => {
    expect(ReadSnapshot.intersectAll([s("10:20:12"), s("11:25:13"), s("9:30:9")])).toBe(
      ReadSnapshot.intersect(ReadSnapshot.intersect(s("10:20:12"), s("11:25:13")), s("9:30:9"))
    );
    expect(ReadSnapshot.intersectAll([s("10:20:12"), undefined])).toBeUndefined();
    expect(ReadSnapshot.intersectAll([])).toBeUndefined();
  });
});
