// The cursor of the wallet list: keyset on wallet_id, ascending. Opaque to clients (the `next` of a page is passed back as `after`); a cursor that is not one of ours is a 400, never a guess.
const maxCursorLength = 512;

export const encodeWalletCursor = (walletId: string): string => Buffer.from(JSON.stringify({ w: walletId })).toString("base64url");

export const decodeWalletCursor = (raw: string): string | null => {
  if (raw === "" || raw.length > maxCursorLength || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { w } = parsed as { w?: unknown };
    return typeof w === "string" && w.length > 0 ? w : null;
  } catch {
    return null;
  }
};
