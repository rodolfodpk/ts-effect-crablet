import { Metric } from "effect";

// crablet.period.clock_behind: a command found a period open that is LATER than the one its clock says it is, and decided in the open one (a model with a period never turns a period back).
// A few now and then is a pod whose clock is a little behind; a steady rate means clocks that disagree. No labels: a period key would grow without bound.
export const clockBehind = Metric.counter("crablet.period.clock_behind");
