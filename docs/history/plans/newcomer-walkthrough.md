# Test sheet: a newcomer walks the documentation, with a stopwatch

*Protocol · a facilitator and one tester · about 90 minutes · 2026-10-13*

The documents have been checked by their author and, once, by an AI agent with no memory of the work ([the record](./newcomer-accessibility.md)). Neither can tell
how long a person takes to read them, or where a person gets lost. This sheet is how to find out. Run it once with one tester; the findings go back into
[`newcomer-accessibility.md`](./newcomer-accessibility.md), and any step that takes more than twice its target is a documentation bug.

## Who and what you need

- **The tester** has never read these documents and has not contributed to the project. They know TypeScript and have used PostgreSQL. They do not need to know Effect or event
  sourcing: that is the point.
- **The facilitator** keeps time, writes down what the tester says and does, and **does not help**. If the tester asks a question, write it down as a finding and say "what would you do if
  you were alone?" Do not read the answer out of your head; the documents have to carry it.
- **A machine** with Bun 1.4 or newer, Node 24 or newer, Docker running, and a fresh clone (`git clone https://github.com/rodolfodpk/ts-effect-crablet.git`). Do not run
  anything beforehand: the install is part of the test.
- **A stopwatch**, and a copy of the [record table](#record-the-results) below.

## Rules for the tester

1. Start at `README.md`. The only other starting point you may use is the one the documents give you.
2. Read the way you would at work: skim if you would skim, stop when you would stop. Do not try to be thorough for the test.
3. Say out loud what you are thinking, and especially **"I do not know what this word means"** and **"I am not sure what to do next"**.
4. Do not read `docs/history/`, `docs/adr/` or the source code unless a page sends you there. If you feel you need to, say so: that is a finding.
5. Stop a step when you think you are done or when you would give up. The facilitator stops it at twice its target.

## The steps

Start the stopwatch when the tester says "I am starting", stop it when they say "I am done" (or at twice the target). Record the time, and what happened.

### 1. What is it for? (target: 2 minutes)

The tester reads `README.md` only. Then, without looking back, they say aloud:

- what the project is for;
- what it is **not** for;
- whether they would depend on it today, and why.

**Expected from the README alone:** event sourcing for TypeScript on PostgreSQL where one command checks a rule that spans several things atomically, without a saga; not for
anyone not on PostgreSQL or needing a stable library now; not ready to depend on (experimental, pre-release, not on npm). A tester who also names Effect or erasing personal
data has read further than the opening, which is fine.

### 2. Run the quick start (target: 10 minutes, no Docker)

From the README: `bun install`, then `node examples/quickstart/src/quickstart.ts`.

**Done when** the tester has seen the seven lines of output and can say, in one sentence, what `bob -> math  failed: CourseFull` and `ann -> chem  failed: StudentAtLimit` mean.

### 3. Tutorial steps 1 and 2 (target: 45 minutes in all, Docker needed from step 2)

The tester follows `docs/tutorial/README.md`, then step 1, then step 2, running every command the pages give. **Done when** step 2 has printed `Migrations applied.` and the two race lines
(`two students race for the last seat: subscribed, CourseFull` and `one student subscribes to four courses: ...`).

Write down: every command that did not do what the page says, every place the tester went back to a previous page, and whether they understood why two students racing for one
seat gives exactly one winner. Ask at the end: "why did the second one get `CourseFull` and not an error from the database?"

### 4. Three questions from the map (target: 10 minutes for the three)

Using only `docs/README.md` and what it links, without searching the repository:

| Question | Where the answer is | Target |
|---|---|---|
| Where is the delivery guarantee for views and automations described? | `docs/concepts/views-and-delivery.md` | 3 minutes |
| Which decision record explains why the progress cursor is a pair of numbers, not one? | `docs/adr/0012-transaction-position-cursors.md` | 4 minutes |
| How do I add a view to an application? | `docs/guides/build/add-a-view.md` | 3 minutes |

Record how many pages the tester opened for each, and whether they were sure of the answer.

### 5. Would you try it? (target: 5 minutes)

From the README, and `docs/concepts/why-not.md` and `docs/evidence.md` if the README sends them there, the tester answers:

- **Why not just use a database transaction?**
- **What is guaranteed, and how do you know?**
- **What does it not do, or what does adopting it cost?**

**Expected:** the transaction is enough when you only need the current state and nothing reacts to writes; the guarantees are listed with the test that checks each, and the numbers say
how many runs they rest on; the costs are pre-release, Effect, a different way to model, background processes to run, a log that only grows, and PostgreSQL only.

Then ask: **"Would you try it on a small real feature? Why, or why not?"** Write the answer down in the tester's own words.

### 6. At 3 a.m. (target: 5 minutes)

The tester is told: "An alert fired: *A module has no leader*. Using only the documentation, say what you would check first, second and third." The answer is in
`docs/guides/operate/runbooks.md`, "A module has no leader". **Done when** the tester can say what each of the first two checks looks at and what they would do if the lock is held
by a session that no process owns.

## Debrief (10 minutes)

Ask, and write down the answers as said:

1. What was the first word or idea you did not understand?
2. Which page did you enjoy reading, and which did you skip or skim?
3. When did you feel lost, and what did you do?
4. What did you expect to find and could not?
5. Is there anything you would take out?

## Record the results

| Step | Target | Actual | Over 2x? | Where the tester stopped, guessed, or went back | Words they did not know |
|---|---|---|---|---|---|
| 1. What is it for? | 2 min | | | | |
| 2. Quick start | 10 min | | | | |
| 3. Tutorial steps 1 and 2 | 45 min | | | | |
| 4a. Delivery guarantee | 3 min | | | | |
| 4b. The cursor ADR | 4 min | | | | |
| 4c. Add a view | 3 min | | | | |
| 5. Would you try it? | 5 min | | | | |
| 6. At 3 a.m. | 5 min | | | | |

Also write down: the tester's role and experience (not their name), the machine, the date, and whether any command failed for a reason outside the documents (Docker not running, a
busy port).

## After the run

1. Copy the filled table, the debrief answers and the tester's "would you try it" answer into a new section of [`newcomer-accessibility.md`](./newcomer-accessibility.md), dated.
2. For every step over twice its target, and every place the tester went wrong, write one line saying which page and what, and change the page. A confusing sentence is a
   documentation bug whoever the reader is.
3. Run the sheet again with a different tester only if the changes were large; one tester finds the worst problems, and a second one mostly finds the same ones.
