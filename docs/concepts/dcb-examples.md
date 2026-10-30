# The dcb.events examples, in this framework

*Concept · anyone comparing this framework with the DCB specification · [consistency boundaries](./dcb-guide.md) read · 10 minutes*

The DCB website has [ten examples](https://dcb.events/examples/). Each one is a business rule that crosses entities, with its events, the projections
its decision reads and its scenarios. All ten are written here against this framework. Each one has its scenarios, run with no database, and at
least one race on Postgres. In each race the racers are held until all of them have read, so the overlap is forced, not hoped for. How the
framework stands against the specification itself, requirement by requirement, is [its compatibility table](./dcb-guide.md#compatibility-with-the-specification).

- **The code:** [`support/dcb-examples.ts`](../../packages/commands/test/support/dcb-examples.ts), one section per example. Course subscriptions is
  the course enrolment app.
- **The scenarios:** [`dcb-examples.test.ts`](../../packages/commands/test/dcb-examples.test.ts). Where the website names its scenarios, the tests use
  the same names.
- **The races:** [`dcb-examples-postgres.test.ts`](../../packages/commands/test/integration/dcb-examples-postgres.test.ts).

## The ten examples

| Example | The rule | The boundary: models, and the tag each is bound by | What it uses | Raced on Postgres |
|---|---|---|---|---|
| [Course subscriptions](https://dcb.events/examples/course-subscriptions/) | A course has a capacity; a student takes at most three courses. | The course (`course_id`) and the student (`student_id`), combined with `all` | `all` | [Two students for the last seat](../../examples/course-enrolment-app/test/integration/step2-postgres.test.ts): one gets it |
| [Unique username](https://dcb.events/examples/unique-username/) | A username is taken once; a released one stays reserved for three days. | The username (`username`, lowercased) | A list tag (a rename tags both names); the event's `occurredAt` | Two registrations of one name: one gets it |
| [Invoice number](https://dcb.events/examples/invoice-number/) | Invoice numbers are unique and have no gaps. | The series (`series`, one constant value) | `retries` | Four invoices at once: numbers 1 to 4 |
| [Dynamic product price](https://dcb.events/examples/dynamic-product-price/) | An order is valid at the prices shown, for ten minutes after a change. | One price per product (`product_id`), as many as the order has lines | `all` built at run time; a list tag on the order; `now` in the input | Two orders of one product: neither retries. A price changed in the middle of an order: the order is re-decided and refused |
| [Opt-in token](https://dcb.events/examples/opt-in-token/) | A one-time password confirms a sign-up once, within an hour. | The sign-up (`email_key`, a hash of the email), narrowed to one `otp` | `scope`; `personal` (the email is never a tag) | Two confirmations of one token: one succeeds |
| [Product reviews](https://dcb.events/examples/product-reviews/) | One review per customer and product, after a purchase, of a listed product. | The product (`product_id`), the customer's purchases of it, and the customer's review of it | `scope` (a model bound by one tag, narrowed by another) | One customer twice: one review. Two customers on one product: neither retries |
| [Bike rental](https://dcb.events/examples/bike-rental/) | A bike is available, rented or in repair; a member rents at most two. | The bike (`bike_id`) and the member (`member_id`) | `all`; two events in one append (a damaged bike is returned and sent to repair together) | Two members on one bike: one gets it. One member renting two more: the limit holds |
| [Library loans](https://dcb.events/examples/library-loans/) | Lend, return and renew copies, at most three loans and two renewals; no renewal for a suspended borrower or a reserved book. | Lending: the copy (`copy_id`) and the member's loans (`member_id`). Renewing: the copy, then its borrower's suspensions and its book's reservations | `resolve`: a read in two steps | Two members on one copy. Two renewals at once. The borrower suspended in the middle of a renewal: the renewal is re-decided and refused |
| [Event-sourced aggregate](https://dcb.events/examples/event-sourced-aggregate/) | A course as one aggregate: capacity changes and subscriptions. | The whole course (`course`): one model that handles every event of it | One model as the aggregate | A capacity change and a subscription at once: one is re-decided on the other's event. Two students for the last seat: one gets it |
| [Prevent record duplication](https://dcb.events/examples/prevent-record-duplication/) | An order placed with a token that was used is not placed again. | The token (`idempotency_token`) | The example's rule; then `idempotentBy` | One token on two orders: one is placed. With `idempotentBy`: one request twice is placed once |

## What the examples show

**A boundary is as small as the rule.** Two customers reviewing one product share the product's tag but not the customer's, and neither of them
retries. Two orders of one product do not conflict either: the price model does not read orders, so an order is not in another order's boundary.
In this framework that is not an optimization a command opts into: the boundary is the set of events its models read, and nothing else.

**An aggregate is the special case of one large boundary.** The aggregate example is one model, bound by the course's tag, that handles every
event of the course:

- its fold is the aggregate's `reconstitute`;
- the cursor the executor carries is the aggregate's version;
- the append under the model's condition is the repository's "fail if anything for this aggregate was stored after my version".

It works as on a stream-based store, and so does its cost: every command on the course conflicts with every other. In the race, a capacity change
and a subscription conflict, and here that is needed, because each rule reads what the other writes (a capacity cannot drop below the
subscriptions; a subscription needs a free seat). A command on the course whose rule reads neither, a new title for instance, would conflict
with both all the same. Under DCB its boundary would be only the events its rule reads.

**A read in two steps is protected at both steps.** A renewal does not know whose suspension and which book's reservations to read until it has
read the copy. The first read is `resolve`, and the models are chosen from what it found. Both reads join the condition. The race suspends the
borrower after the renewal has read and before it appends. The append is refused, and the renewal is re-decided and refused because the borrower
is suspended. A read that was left out of the condition would make the test fail; it was broken on purpose to check that.

**A rule that holds "across all" still needs a key.** A model is bound by a tag, so the gap-free invoice numbers are a model bound by a constant
`series` tag. Every invoice is in one boundary, which is what gap-free means: invoices are numbered one at a time, and racers retry.

**Personal data is not a tag.** Tags are plain indexed text and cannot be erased. In the opt-in example the email is marked `personal`, and the
sign-up is found by a hash of it. `defineEvent` refuses a tag whose value is a personal field's value.

**Time is an input.** Where a rule depends on the time (the price's grace period, the token's hour), `now` is in the input or comes from the
event's `occurredAt`, so the scenarios can run at any date.

## Where this differs from the website

- **Duplication: `idempotentBy`.** The website's rule refuses an order whose token was used. That rule is written here as it is, and also with
  the framework's `idempotentBy` ([ADR-0034](../adr/0034-a-repeat-must-be-the-same-request.md)), which answers differently:
  - the same request sent again is "already done", with the first outcome, instead of an error;
  - a different order under a used token is an `IdempotencyMismatch`.

  The DCB guide [explains why](./dcb-guide.md#how-this-relates-to-the-dcb-specification).
- **The projections are grouped into models.** The website gives each value its own projection. When several projections read the same events,
  one model holds them all: library loans' `CopyInCatalog`, `CopyBookId`, `CopyBorrowerId` and `CopyRenewals` are one model of the copy. The
  boundary is the same, because the events read are the same.
- **Names.** The duplication example's `OrderPlaced` is `PurchaseOrderPlaced` here, because the product reviews' order already has that name.
  Tags are written `snake_case`.
- **The event-sourced aggregate's scenarios** are not on the website; they follow its three rules.
- **Not ported:** the website's notation and its playground. Here an example is code and tests.
