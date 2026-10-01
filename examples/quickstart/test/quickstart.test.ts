// Pins the output of the README's runnable quick start (examples/quickstart/src/quickstart.ts).
import { expect, test } from "bun:test";
import { run } from "../src/quickstart.ts";

test("the quick start prints what the README says it does", async () => {
  expect(await run()).toEqual([
    "add 12A            -> created: SeatAdded",
    "add 12A again      -> idempotent: nothing appended",
    "book 12A for Ann   -> created: SeatBooked",
    "book 12A for Bob   -> failed: SeatTaken",
    "book 99Z for Bob   -> failed: SeatNotFound",
    "book 12A for Cy, history: SeatAdded + SeatBooked -> failed: SeatTaken"
  ]);
});
