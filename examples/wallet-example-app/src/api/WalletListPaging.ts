import { Schema } from "effect";
import { opaqueCursor } from "./OpaqueCursor.ts";

// The cursor of the wallet list: keyset on wallet_id, ascending. Opaque to clients (the `next` of a page is passed back as `after`); a cursor that is not
// one of ours is a 400, never a guess. On the wire: `{ w }`, as JSON, base64url (`OpaqueCursor`).
const WalletCursorKey = Schema.Struct({ walletId: Schema.NonEmptyString }).pipe(Schema.encodeKeys({ walletId: "w" }));
const walletCursor = opaqueCursor<{ readonly walletId: string }>(WalletCursorKey, 512);

export const encodeWalletCursor = (walletId: string): string => walletCursor.encode({ walletId });
export const decodeWalletCursor = (raw: string): string | null => walletCursor.decode(raw)?.walletId ?? null;
