// Pins the output of the README's runnable quick start (examples/quickstart/src/quickstart.ts).
import { expect, test } from "bun:test";
import { run } from "../src/quickstart.ts";

test("the quick start prints what the README says it does", async () => {
  expect(await run()).toEqual([
    "12A for Ann -> created: SeatBooked",
    "12A for Bob -> failed: SeatTaken",
    "12B for Bob -> created: SeatBooked",
    "12A for Cy, after a SeatBooked in the history -> failed: SeatTaken"
  ]);
});
