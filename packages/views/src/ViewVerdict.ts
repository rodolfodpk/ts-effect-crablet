import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";

// What a read does about one view, given where the view is. The one place this is decided: `waitUntilProcessed` (one view, looking again and again) and `readCheck` (every view, in
// one statement) both end in it, so the two ways of looking cannot disagree.
//
//   caught_up - nothing to wait for: the view's cursor is at or past the write, OR the view is behind it but nothing the view handles is pending in between (the write is an event
//               it ignores; a cursor only ever lands on events the view matched, so "behind" alone does not mean "late")
//   failed    - the view is behind with something pending and is FAILED: it will not progress, so waiting is pointless
//   wait      - the view is behind with something pending and is working on it (or paused, or has no row yet)
//
// `status` is null when the view has no progress row yet. `pending` only matters while the cursor is behind the write.
export type ViewVerdict = "caught_up" | "failed" | "wait";

export const viewVerdict = (write: ProgressCursor, cursor: ProgressCursor, status: string | null, pending: boolean): ViewVerdict => {
  if (ProgressCursorNS.compare(cursor, write) >= 0) return "caught_up";
  if (!pending) return "caught_up";
  return status === "FAILED" ? "failed" : "wait";
};
