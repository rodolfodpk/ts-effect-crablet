// A write marker: where in the log one write ended (the transaction that wrote its last event, and that event's position), as one string a
// client can hold and send back later. A reader that has it can ask for a view that has reached it (ADR-0015). It is a `LogPoint`: the same
// type a processor's progress is, so waiting for a write compares the two directly.
import * as LogPoint from "./LogPoint.ts";

export type Marker = LogPoint.LogPoint;

export const formatMarker: (marker: Marker) => string = LogPoint.format;

// null for anything that is not a marker; callers answer a 400 for it.
export const parseMarker: (raw: string) => Marker | null = LogPoint.parse;
