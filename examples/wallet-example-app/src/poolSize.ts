// The most connections the pool may open (WALLET_DB_POOL). Unset: the library's own default, so a deployment that never sets it behaves as before. The pool is shared by
// commands, reads, the three processors, and the connections this process holds for good (see "Size the pool" in docs/guides/run-in-production.md).
export const poolSizeFromEnv = (value: string | undefined = process.env["WALLET_DB_POOL"]): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1) throw new Error(`WALLET_DB_POOL must be a whole number of 1 or more, got "${value}"`);
  return size;
};
