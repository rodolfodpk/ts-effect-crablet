// The notification a view's progress sends when it advances: the channel, and (from the poller) the shape of the ping. The views module turns it on for
// `crablet_view_progress`; a feed that tells clients "this view moved" listens to it.
export { ProgressPing as ViewProgressPing, decodeProgressPing as decodeViewProgressPing } from "@crablet/event-poller/ProgressPing";

export const VIEW_PROGRESS_CHANNEL = "crablet_view_progress";
