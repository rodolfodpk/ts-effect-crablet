// A processor's progress and a command's write marker are one type, `LogPoint`: `@crablet/modules` declares `ProgressCursor` without depending on
// the event store, and this keeps the two equal, so a marker is compared with a view's cursor with no conversion.
import type { LogPoint } from "@crablet/eventstore/LogPoint";
import type { Marker } from "@crablet/eventstore/Marker";
import type { ProgressCursor } from "@crablet/modules";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const progressCursorIsALogPoint: Equal<ProgressCursor, LogPoint> = true;
export const markerIsALogPoint: Equal<Marker, LogPoint> = true;
// @ts-expect-error a type with one more field is not a LogPoint
export const notEqual: Equal<ProgressCursor, LogPoint & { readonly occurredAt: Date }> = true;
