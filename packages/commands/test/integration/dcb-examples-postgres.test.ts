// Runs under Node (Testcontainers). Races from the dcb.events examples (support/dcb-examples.ts) on real
// Postgres: each is "several actors, one invariant, exactly the right outcome".
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Metric, Redacted } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { SqlClient } from "effect/sql";
import { EventStore } from "@crablet/eventstore";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { barrier } from "../support/barrier.ts";
import {
  BikeAddedToFleet,
  BikeNotAvailable,
  BikeRented,
  OrderPlaced,
  ProductAlreadyReviewed,
  RentalLimitReached,
  SignUpInitiated,
  TokenInvalid,
  UsernameClaimed,
  confirmSignUpWith,
  createInvoiceWith,
  registerAccountWith,
  rentBikeWith,
  reviewProductWith
} from "../support/dcb-examples.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);
const errorOf = (exit: any) => exit.cause?.reasons?.find((r: any) => r._tag === "Fail")?.error;
const exitAll = (effects: ReadonlyArray<Effect.Effect<any, any, any>>) =>
  Effect.all(effects.map((e) => Effect.exit(e)), { concurrency: effects.length });
const uid = () => crypto.randomUUID().slice(0, 8);
// Every racer has LOADED (a barrier right after its load) before any appends, so the commands really overlap. The recorded
// conflict retries prove it: the losers were refused at append time and re-decided.
const retriesOf = (commandType: string) =>
  Effect.map(Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: commandType })), (m) => m.count);

describe("dcb.events examples on Postgres", () => {
  it("unique username: two people registering the same name at once - exactly one gets it", async () => {
    const name = `user-${uid()}`;
    const exits = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const register = registerAccountWith(yield* barrier(2));
        const exits = yield* exitAll([
          executor.run(register, { username: name, now: Date.now() }),
          executor.run(register, { username: name.toUpperCase(), now: Date.now() })
        ]);
        return { exits, retries: yield* retriesOf("register_account_raced") };
      })
    ).then(({ exits, retries }) => {
      assert.ok(retries >= 1, `the commands did not actually race (retries: ${retries})`);
      return exits;
    });
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(exits.find((e) => e._tag === "Failure")) instanceof UsernameClaimed);
  });

  it("invoice numbers: concurrent creations get distinct, consecutive numbers (gap-free)", async () => {
    // a fresh container per file, so the series starts at 1. Four racers need at most three retries.
    const numbers = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const sql = yield* SqlClient.SqlClient;
        const create = createInvoiceWith(yield* barrier(4), 3);
        const exits = yield* exitAll([1, 2, 3, 4].map((n) => executor.run(create, { invoiceData: `inv ${n}` })));
        assert.ok((yield* retriesOf("create_invoice_raced")) >= 3, "all four loaded the same state, so at least three had to retry");
        assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success", "Success", "Success"]);
        const rows = yield* sql<{ n: number }>`
          SELECT (data->>'invoiceNumber')::int AS n FROM crablet_events WHERE type = 'InvoiceCreated' ORDER BY position`;
        return rows.map((r) => r.n);
      })
    );
    assert.deepEqual(numbers, [1, 2, 3, 4]);
  });

  it("opt-in token: two confirmations of the same token at once - exactly one succeeds", async () => {
    const email = `ann-${uid()}@example.com`;
    const otp = uid();
    const exits = await run(
      Effect.gen(function* () {
        const es = yield* EventStore;
        yield* es.append([SignUpInitiated({ email, otp, name: "Ann" })]);
        const executor = yield* CommandExecutor;
        const confirm = confirmSignUpWith(yield* barrier(2));
        const exits = yield* exitAll([
          executor.run(confirm, { email, otp, now: Date.now() }),
          executor.run(confirm, { email, otp, now: Date.now() })
        ]);
        assert.ok((yield* retriesOf("confirm_sign_up_raced")) >= 1, "the confirmations did not actually race");
        return exits;
      })
    );
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.equal((errorOf(exits.find((e) => e._tag === "Failure")) as TokenInvalid).reason, "already used");
  });

  it("product reviews: the same customer reviewing the same product twice at once - exactly one review", async () => {
    const [product, customer] = [`p-${uid()}`, `c-${uid()}`];
    const { exits, retries } = await run(
      Effect.gen(function* () {
        yield* (yield* EventStore).append([OrderPlaced({ customerId: customer, lines: [{ productId: product, quantity: 1 }] })]);
        const executor = yield* CommandExecutor;
        const review = reviewProductWith(yield* barrier(2));
        const before = yield* retriesOf("review_product_raced");
        const exits = yield* exitAll([4, 5].map((rating) => executor.run(review, { productId: product, customerId: customer, rating })));
        return { exits, retries: (yield* retriesOf("review_product_raced")) - before };
      })
    );
    assert.ok(retries >= 1, `the reviews did not actually race (retries: ${retries})`);
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(exits.find((e) => e._tag === "Failure")) instanceof ProductAlreadyReviewed);
  });

  it("product reviews: two customers reviewing one product at once are outside each other's boundary - both succeed, neither retries", async () => {
    const product = `p-${uid()}`;
    const customers = [`c-${uid()}`, `c-${uid()}`];
    const { exits, retries } = await run(
      Effect.gen(function* () {
        yield* (yield* EventStore).append(customers.map((customerId) => OrderPlaced({ customerId, lines: [{ productId: product, quantity: 1 }] })));
        const executor = yield* CommandExecutor;
        const review = reviewProductWith(yield* barrier(2));
        const before = yield* retriesOf("review_product_raced");
        const exits = yield* exitAll(customers.map((customerId) => executor.run(review, { productId: product, customerId, rating: 5 })));
        return { exits, retries: (yield* retriesOf("review_product_raced")) - before };
      })
    );
    assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success"]);
    assert.equal(retries, 0, "one customer's review is not a conflict for another's");
  });

  it("bike rental: two members renting the same bike at once - exactly one gets it", async () => {
    const bike = `b-${uid()}`;
    const { exits, retries } = await run(
      Effect.gen(function* () {
        yield* (yield* EventStore).append([BikeAddedToFleet({ bikeId: bike })]);
        const executor = yield* CommandExecutor;
        const rent = rentBikeWith(yield* barrier(2));
        const before = yield* retriesOf("rent_bike_raced");
        const exits = yield* exitAll([`m-${uid()}`, `m-${uid()}`].map((memberId) => executor.run(rent, { bikeId: bike, memberId })));
        return { exits, retries: (yield* retriesOf("rent_bike_raced")) - before };
      })
    );
    assert.ok(retries >= 1, `the rentals did not actually race (retries: ${retries})`);
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(exits.find((e) => e._tag === "Failure")) instanceof BikeNotAvailable);
  });

  it("bike rental: a member with one bike renting two more at once - the limit of two holds across bikes", async () => {
    const member = `m-${uid()}`;
    const bikes = [`b-${uid()}`, `b-${uid()}`, `b-${uid()}`];
    const { exits, retries } = await run(
      Effect.gen(function* () {
        yield* (yield* EventStore).append([...bikes.map((bikeId) => BikeAddedToFleet({ bikeId })), BikeRented({ bikeId: bikes[0]!, memberId: member })]);
        const executor = yield* CommandExecutor;
        const rent = rentBikeWith(yield* barrier(2));
        const before = yield* retriesOf("rent_bike_raced");
        // different bikes, so only the member's part of each boundary is shared
        const exits = yield* exitAll(bikes.slice(1).map((bikeId) => executor.run(rent, { bikeId, memberId: member })));
        return { exits, retries: (yield* retriesOf("rent_bike_raced")) - before };
      })
    );
    assert.ok(retries >= 1, `the rentals did not actually race (retries: ${retries})`);
    assert.equal(exits.filter((e) => e._tag === "Success").length, 1);
    assert.ok(errorOf(exits.find((e) => e._tag === "Failure")) instanceof RentalLimitReached);
  });
});
