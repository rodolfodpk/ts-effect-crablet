// What a read could see: the Postgres snapshot it was taken in (`pg_current_snapshot()`, text `xmin:xmax:xip1,xip2,...`). Every transaction below
// `xmin` had finished, those in `xip` were running, and those from `xmax` on had not started; an event was visible to the read when its transaction
// had finished. An append condition that carries it counts as a conflict only an event the read could NOT see (ADR-0048).
//
// Opaque to users: only the Postgres event store makes one (`project`), and only @crablet/commands combines them (`intersect`). Internal entry point.
declare const brand: unique symbol;
export type ReadSnapshot = string & { readonly [brand]: "ReadSnapshot" };

interface Parts {
  readonly xmin: bigint;
  readonly xmax: bigint;
  readonly xip: ReadonlyArray<bigint>;
}

export const fromText = (text: string): ReadSnapshot => {
  parse(text as ReadSnapshot);
  return text as ReadSnapshot;
};

export const parse = (snapshot: ReadSnapshot): Parts => {
  const match = /^(\d+):(\d+):([\d,]*)$/.exec(snapshot);
  if (match === null) throw new Error(`not a pg_snapshot: ${snapshot}`);
  const xip = match[3] === "" ? [] : match[3]!.split(",").map(BigInt);
  return { xmin: BigInt(match[1]!), xmax: BigInt(match[2]!), xip };
};

const format = ({ xmin, xmax, xip }: Parts): ReadSnapshot => `${xmin}:${xmax}:${xip.join(",")}` as ReadSnapshot;

// Visible in `snapshot`, the way pg_visible_in_snapshot answers for a finished transaction.
export const sees = (snapshot: ReadSnapshot, xid: bigint): boolean => {
  const { xmin, xmax, xip } = parse(snapshot);
  return xid < xmin || (xid < xmax && !xip.includes(xid));
};

// The snapshot that sees exactly what BOTH see: a command that read several times may treat as seen only what every read saw, so an event one of its
// reads missed stays a conflict. Below the smaller xmin both had finished; from the smaller xmax on, at least one had not started it; in between, a
// transaction either running for one of them is not seen.
export const intersect = (a: ReadSnapshot, b: ReadSnapshot): ReadSnapshot => {
  const pa = parse(a), pb = parse(b);
  const xmax = pa.xmax < pb.xmax ? pa.xmax : pb.xmax;
  const xmin = pa.xmin < pb.xmin ? pa.xmin : pb.xmin;
  const xip = [...new Set([...pa.xip, ...pb.xip])].filter((x) => x < xmax).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return format({ xmin, xmax, xip });
};

// Of several reads (any of which may not carry one, like the in-memory store's): what all of them saw, or nothing to refine the condition with
// when one did not carry a snapshot (the condition then works as before ADR-0048, by its cursor alone).
export const intersectAll = (snapshots: ReadonlyArray<ReadSnapshot | undefined>): ReadSnapshot | undefined => {
  if (snapshots.length === 0 || snapshots.some((s) => s === undefined)) return undefined;
  return (snapshots as ReadonlyArray<ReadSnapshot>).reduce(intersect);
};
