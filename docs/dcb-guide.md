# Dynamic Consistency Boundaries: one decision, several entities

*An unfamiliar word? See the [glossary](./glossary.md). All documents: [docs/README.md](./README.md).*

Most event-sourcing frameworks make you pick an *aggregate* up front: every event belongs to one stream, and
a command may only decide on one stream. "Move money from account A to B" then needs a saga or a
two-phase dance, because the decision reads two streams.

Here there are no streams. There is one log of events, each found by **tags**. A command declares the
events it needs in order to decide - its *boundary* - and the append succeeds only if nothing in that
boundary changed since the command read it. That is the whole idea; the transfer below is the smallest
example where it matters.

## The code

Everything below is `packages/commands/test/support/transfer.ts` (the tests run exactly this).

```ts
// Events. Note there are no streams or aggregates: an event is found by its TAGS.
export const AccountOpened = defineEvent("AccountOpened", {
  schema: Schema.Struct({ accountId: Schema.String, balance: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
export const Deposited = defineEvent("Deposited", {
  schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
export const Transferred = defineEvent("Transferred", {
  schema: Schema.Struct({ transferId: Schema.String, from: Schema.String, to: Schema.String, amount: Schema.Number }),
  // ONE event, findable through either account - this is what lets one fact touch two entities.
  tags: (d) => ({ transfer_id: d.transferId, from_account_id: d.from, to_account_id: d.to })
});

// Model of ONE account: its balance, and (from the same declaration) every event that could change it.
export const AccountModel = defineModel({ by: "account_id", initial: () => ({ exists: false, balance: 0 }) })
  .on(AccountOpened, (_, d) => ({ exists: true, balance: d.balance }))
  .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount }))
  .on(Transferred, (a, d, ctx) => ({ ...a, balance: a.balance + (d.to === ctx.id ? d.amount : -d.amount) }), {
    by: ["from_account_id", "to_account_id"] // a transfer belongs to BOTH accounts
  });

export class AccountNotFound extends DomainError("AccountNotFound", {
  fields: { accountId: Schema.String },
  kind: "not_found"
}) {}
export class InsufficientFunds extends DomainError("InsufficientFunds", {
  fields: { accountId: Schema.String, balance: Schema.Number, requested: Schema.Number },
  kind: "conflict"
}) {}

export const transferInput = Schema.Struct({
  transferId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number.check(Schema.isGreaterThan(0))
});

export const Transfer = defineCommand({
  name: "transfer",
  errors: [AccountNotFound, InsufficientFunds],
  input: transferInput,
  // The decision reads TWO accounts. `all` makes the boundary the union of both accounts' events, so a
  // change to EITHER one after we loaded refuses the append (and the command is re-run).
  model: (c) => all({ from: AccountModel.of({ id: c.from }), to: AccountModel.of({ id: c.to }) }),
  idempotentBy: (c) => Transferred.where({ transfer_id: c.transferId }), // a repeat is "already done"
  decide: ({ from, to }, c) =>
    !from.exists
      ? fail(new AccountNotFound({ accountId: c.from }))
      : !to.exists
        ? fail(new AccountNotFound({ accountId: c.to }))
        : from.balance < c.amount
          ? fail(new InsufficientFunds({ accountId: c.from, balance: from.balance, requested: c.amount }))
          : emit(Transferred(c))
});
```

What to notice:

- **`Transferred` carries three tags** (`transfer_id`, `from_account_id`, `to_account_id`). One fact, found
  through either account. The model's `by: [...]` says a transfer belongs to *both*.
- **`all({ from, to })`** is the boundary: the union of both accounts' events. The command says nothing
  about locks or versions; the boundary *is* the declaration.
- **`decide` is pure.** It gets both accounts' state and returns `emit`, `fail` or `noop`. No database.
- **Consistency is strict by default**: if anything in the boundary changed between load and append, the
  append is refused and the whole command is re-run (up to 3 times) with fresh state.
- **`idempotentBy`** makes a repeated `transferId` "already done" instead of a second transfer - and it is
  checked *before* deciding, so a retry after the money has moved does not wrongly fail with
  `InsufficientFunds`.

## What the tests show

No database (`packages/commands/test/transfer-guide.test.ts`, `bun test`):

- a transfer appends one `Transferred` event, findable through both accounts;
- later decisions see earlier transfers on both sides (the receiver can spend what it received);
- overspending and unknown accounts are refused and append nothing;
- a repeated transfer id is "already done" even though the sender is now empty.

Real Postgres (`packages/commands/test/integration/transfer-guide-postgres.test.ts`). Each race uses a barrier so
every racer has *loaded* before any appends - no timing luck:

| Scenario | Result |
|---|---|
| Two transfers of 80 out of an account holding 100 (to different receivers) | Exactly one wins. The loser is retried, re-reads 20, and fails with `InsufficientFunds`. The sender is debited once. |
| Transfers between disjoint accounts (A→B, C→D), retries off | Both succeed: disjoint boundaries never conflict. |
| Two transfers sharing only the receiver (A→B, C→B), retries off | One gets a `Conflict`: the receiver is in both boundaries. |
| The same, with retries (the default) | Both succeed: the loser re-runs on fresh state. Neither is lost. |
| Same `transferId` twice | The second is "already done"; balances are unchanged. |

The third and fourth rows are the point: the boundary is **exactly as wide as the decision** - no wider (disjoint
accounts run in parallel) and no narrower (a shared account is protected).

## A rule no aggregate can own: course enrolment

The transfer spans two *instances* of the same kind of thing. The harder case is one decision governed by two
*different* kinds of rule:

- a course holds at most `capacity` students, and
- a student takes at most 3 courses.

With aggregates, "course" and "student" each claim to own `StudentSubscribed`, and you must choose one and
enforce the other eventually (or with a saga). Here both rules are checked in one decision, atomically, because
one event is tagged with both the student and the course, and two models look at it from each side.
(`packages/commands/test/support/enrolment.ts`)

```ts
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, capacity: Schema.Number }),
  tags: (d) => ({ course_id: d.courseId })
});
// One fact, tagged with BOTH the student and the course it concerns.
export const StudentSubscribed = defineEvent("StudentSubscribed", {
  schema: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
  tags: (d) => ({ student_id: d.studentId, course_id: d.courseId })
});

export const MAX_COURSES_PER_STUDENT = 3;

// Two models over the SAME events, looked at from two sides.
export const CourseModel = defineModel({
  by: "course_id",
  initial: () => ({ exists: false, capacity: 0, subscribers: 0 })
})
  .on(CourseDefined, (c, d) => ({ ...c, exists: true, capacity: d.capacity }))
  .on(StudentSubscribed, (c) => ({ ...c, subscribers: c.subscribers + 1 }));

export const StudentModel = defineModel({ by: "student_id", initial: () => ({ courses: [] as ReadonlyArray<string> }) })
  .on(StudentSubscribed, (s, d) => ({ courses: [...s.courses, d.courseId] }));

export class CourseNotFound extends DomainError("CourseNotFound", {
  fields: { courseId: Schema.String },
  kind: "not_found"
}) {}
export class CourseFull extends DomainError("CourseFull", {
  fields: { courseId: Schema.String, capacity: Schema.Number },
  kind: "conflict"
}) {}
export class StudentAtLimit extends DomainError("StudentAtLimit", {
  fields: { studentId: Schema.String, limit: Schema.Number },
  kind: "conflict"
}) {}

export const subscribeInput = Schema.Struct({ studentId: Schema.String, courseId: Schema.String });

type Course = { readonly exists: boolean; readonly capacity: number; readonly subscribers: number };
type Student = { readonly courses: ReadonlyArray<string> };

// Two rules, two different entities, ONE decision:
//   - a course holds at most `capacity` students,
//   - a student takes at most 3 courses.
const decide = ({ course, student }: { course: Course; student: Student }, c: { studentId: string; courseId: string }) =>
  !course.exists
    ? fail(new CourseNotFound({ courseId: c.courseId }))
    : student.courses.includes(c.courseId)
      ? noop("ALREADY_SUBSCRIBED")
      : course.subscribers >= course.capacity
        ? fail(new CourseFull({ courseId: c.courseId, capacity: course.capacity }))
        : student.courses.length >= MAX_COURSES_PER_STUDENT
          ? fail(new StudentAtLimit({ studentId: c.studentId, limit: MAX_COURSES_PER_STUDENT }))
          : emit(StudentSubscribed(c));

export const Subscribe = defineCommand({
  name: "subscribe",
  errors: [CourseNotFound, CourseFull, StudentAtLimit],
  input: subscribeInput,
  // The boundary is the union of the course's events and the student's events.
  model: (c) => all({ course: CourseModel.of({ id: c.courseId }), student: StudentModel.of({ id: c.studentId }) }),
  decide
});
```

What to notice:

- **One event, two models.** `CourseModel` counts subscribers; `StudentModel` lists a student's courses. Both
  fold `StudentSubscribed`, through different tags (`course_id`, `student_id`).
- **The boundary is the union of the two.** A new subscription by *anyone* to this course, or by *this student* to
  any course, changes what the command read, so a stale decision is refused.
- **Subscribing twice is `noop`**, reported as an idempotent success: a domain-level "already done" with no
  `idempotentBy` needed.

Tests: `enrolment-guide.test.ts` (no database) and `integration/enrolment-guide-postgres.test.ts` (real races):

| Scenario | Result |
|---|---|
| The last seat in a course, two *different* students racing | Exactly one gets it; the loser re-decides and gets `CourseFull`. The two students share only the course. |
| A student's last slot, one student racing into two *different* courses | Exactly one succeeds; the loser gets `StudentAtLimit`. The two commands share only the student. |
| Different student and different course, retries off | Both succeed: nothing shared, nothing conflicts. |
| Two students into the same roomy course, retries off | One `Conflict` (the course is in both boundaries); with retries both get in. |

Each race protects a *different* rule, and each is protected by the same mechanism: the part of the boundary the two
commands share.

## When you do not need the boundary to be strict

A command that can safely run in parallel with itself - say a deposit, which only ever adds - can say
`consistency: () => concurrent({ guard })`: concurrent runs do not conflict with each other, and only the
`guard` events (for example "is the account closed?") can still refuse the append. The real wallet example uses
this for deposits; see `examples/wallet-example-app/src/domain/commands/`. The full-size version of the transfer,
with statement periods and lifecycle checks, is `TransferMoneyCommand.ts` there.

## How this relates to the DCB specification

The [DCB specification](https://dcb.events/specification/) defines one append condition,
`{ failIfEventsMatch: Query, after?: position }`: the append fails if any event matching the query exists after
the position the client last saw. A query is a set of items combined with OR, and an item matches an event whose type is
one of its types AND that carries all of its tags. What this framework does with it:

- **Boundary and `strict()`** are the spec's condition as written: the query that built the decision model,
  plus the point in the log it was read at. That point is a `(transaction_id, position)` pair, not a bare position:
  a sequence value and a transaction id can be taken in opposite orders, so "after position N" alone can miss an event
  that commits later with a lower position (migration V7, [ADR-0012](adr/0012-transaction-position-cursors.md)).
- **`concurrent({ guard })`** uses the spec's allowance for a condition query that is *narrower* than the read
  query (the spec says the two are "typically" the same, not always). Only the guard's events can refuse the append.
- **Query items** follow the spec: OR between items, type AND tags within one. Multi-item conditions are enforced
  that way on Postgres (migration V4) and by the in-memory store, and a conformance suite runs the same cases on both.
- **Writers lock their own events too** (migration V5). Every append locks the (event type, tag) pairs of its own events
  as well as of its condition, so a check always waits for an in-flight writer whose events it would match, even one
  that has no condition of its own (a `concurrent()` command). The price: appends to one hot (type, tag) queue, and two
  commands that each append more than once can deadlock, which the executor treats as a conflict and retries.
- **Idempotency is our addition, not part of the specification.** The spec has one condition and does not discuss
  idempotency; its examples ("Prevent record duplication") do it with a token event and the ordinary condition, where a
  repeat is just another failed condition. Here `idempotentBy` is a second, independent check that runs *before* the
  concurrency check and reports a repeat as "already done" instead of as a conflict. The practical difference: a retry
  after the state has moved on (a transfer whose sender is now empty) is recognised as a repeat instead of
  being re-decided or refused as a conflict.
