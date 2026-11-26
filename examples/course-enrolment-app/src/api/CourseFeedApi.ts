import { liveFeedGroup } from "@crablet/views-http/LiveFeedApi";

// The live-update feed (GET /api/views/changes): the group @crablet/views-http declares, under the course's name.
export const courseFeedGroup = liveFeedGroup("courseFeed");
export { ViewAdvanced } from "@crablet/views-http/LiveFeedApi";
