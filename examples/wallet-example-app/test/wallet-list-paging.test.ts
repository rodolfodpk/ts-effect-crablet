import { describe, expect, test } from "bun:test";
import { decodeWalletCursor, encodeWalletCursor } from "../src/api/WalletListPaging.ts";

describe("the wallet list's cursor", () => {
  test("round-trips any wallet id", () => {
    for (const id of ["w-1", "load-ab12cd34-7", "ünï:cödé/ß", "a".repeat(200)]) expect(decodeWalletCursor(encodeWalletCursor(id))).toBe(id);
  });
  test("anything that is not one of our cursors is refused", () => {
    for (const bad of ["", "not a cursor!", "e30", Buffer.from("[]").toString("base64url"), Buffer.from(JSON.stringify({ w: "" })).toString("base64url"), Buffer.from(JSON.stringify({ w: 5 })).toString("base64url"), "A".repeat(600)]) {
      expect(decodeWalletCursor(bad), bad).toBeNull();
    }
  });
});
