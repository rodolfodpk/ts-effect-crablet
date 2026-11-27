import { describe, expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, Exit, Redacted } from "effect";
import { defaultPollingConfig } from "@crablet/event-poller/ProcessorConfig";
import * as Crablet from "../src/index.ts";

const read = <A>(config: Config.Config<A>, env: Record<string, string>) =>
  Effect.runPromiseExit(Effect.gen(function* () { return yield* config; }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))));
const value = async <A>(config: Config.Config<A>, env: Record<string, string> = {}) => {
  const exit = await read(config, env);
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};
const failure = async <A>(config: Config.Config<A>, env: Record<string, string>) => {
  const exit = await read(config, env);
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  return String(exit.cause);
};

const wallet = Crablet.config("WALLET", { roles: ["api"], database: { name: "wallet_db", username: "postgres", password: "postgres" } });

describe("Crablet.config: one process's settings, from the environment, under the product's prefix", () => {
  test("unset, it is today's defaults: the database the call names, the library's pool, no session, the default polling, wake-ups on, every role, migrate on", async () => {
    const s = await value(wallet);
    expect({ ...s.pg, password: Redacted.value(s.pg.password!) }).toEqual({ host: "localhost", port: 5432, database: "wallet_db", username: "postgres", password: "postgres" });
    expect(s.options).toEqual({ eventStore: { wakeupMode: "coalesced" } });
    expect(s.polling).toEqual({ pollingIntervalMs: defaultPollingConfig.pollingIntervalMs, backoffMaxSeconds: defaultPollingConfig.backoffMaxSeconds });
    expect(s.roles.modules).toBe("all");
    expect([...s.roles.app]).toEqual(["api"]);
    expect(s.migrate).toBe(true);
  });

  test("each part is read under the prefix", async () => {
    const s = await value(wallet, {
      WALLET_DB_HOST: "db.internal", WALLET_DB_PORT: "6432", WALLET_DB_NAME: "w", WALLET_DB_USER: "app", WALLET_DB_PASSWORD: "s3cret", WALLET_DB_POOL: "20",
      WALLET_POLL_MS: "250", WALLET_BACKOFF_MAX_SECONDS: "3", WALLET_WAKEUPS: "off", WALLET_MIGRATE: "off"
    });
    expect({ ...s.pg, password: Redacted.value(s.pg.password!) }).toEqual({ host: "db.internal", port: 6432, database: "w", username: "app", password: "s3cret", maxConnections: 20 });
    expect(s.options).toEqual({ eventStore: { wakeupMode: "off" } });
    expect(s.polling).toEqual({ pollingIntervalMs: 250, backoffMaxSeconds: 3 });
    expect(s.migrate).toBe(false);
  });

  test("the password is redacted: it does not show when the settings are printed", async () => {
    expect(JSON.stringify(await value(wallet, { WALLET_DB_PASSWORD: "s3cret" }))).not.toContain("s3cret");
  });

  test("DB_URL, as platforms give it, wins over the parts", async () => {
    const s = await value(wallet, { WALLET_DB_URL: "postgres://app:p%40ss@db.example:6543/prod", WALLET_DB_HOST: "ignored", WALLET_DB_POOL: "5" });
    expect({ ...s.pg, password: Redacted.value(s.pg.password!) }).toEqual({ host: "db.example", port: 6543, database: "prod", username: "app", password: "p@ss", maxConnections: 5 });
  });

  test("a DB_URL that is not a postgres URL with a database is refused, naming the variable", async () => {
    expect(await failure(wallet, { WALLET_DB_URL: "mysql://a@b/c" })).toContain('["WALLET"]["DB_URL"]');
    expect(await failure(wallet, { WALLET_DB_URL: "postgres://a@b" })).toContain('["WALLET"]["DB_URL"]');
  });

  test("a database setting the call does not default must be set", async () => {
    expect(await failure(Crablet.config("COURSES"), {})).toContain('["COURSES"]["DB_NAME"]');
  });

  test("with DB_SESSION_HOST, a direct session connection: each of its parts falls back to the main one, its pool to 10", async () => {
    const s = await value(wallet, { WALLET_DB_HOST: "pgbouncer", WALLET_DB_USER: "app", WALLET_DB_SESSION_HOST: "db-direct", WALLET_DB_SESSION_PORT: "5433" });
    const session = s.options.session!;
    expect({ ...session, password: Redacted.value(session.password!) }).toEqual({ host: "db-direct", port: 5433, database: "wallet_db", username: "app", password: "postgres", maxConnections: 10 });
    expect((await value(wallet, { WALLET_DB_SESSION_HOST: "d", WALLET_DB_SESSION_POOL: "4" })).options.session?.maxConnections).toBe(4);
  });

  test("the minimums are today's, and a value below one names its variable", async () => {
    expect(await failure(wallet, { WALLET_DB_POOL: "0" })).toContain('["WALLET"]["DB_POOL"]');
    expect(await failure(wallet, { WALLET_DB_SESSION_HOST: "d", WALLET_DB_SESSION_POOL: "0" })).toContain('["WALLET"]["DB_SESSION_POOL"]');
    expect(await failure(wallet, { WALLET_POLL_MS: "49" })).toContain('["WALLET"]["POLL_MS"]');
    expect(await failure(wallet, { WALLET_BACKOFF_MAX_SECONDS: "0" })).toContain('["WALLET"]["BACKOFF_MAX_SECONDS"]');
    expect(await failure(wallet, { WALLET_DB_PORT: "x" })).toContain('["WALLET"]["DB_PORT"]');
    expect(await failure(wallet, { WALLET_WAKEUPS: "sometimes" })).toContain('["WALLET"]["WAKEUPS"]');
    expect(await failure(wallet, { WALLET_MIGRATE: "maybe" })).toContain('["WALLET"]["MIGRATE"]');
  });
});

describe("ROLES: what the process does (ADR-0022)", () => {
  const roles = async (ROLES: string) => (await value(wallet, { WALLET_ROLES: ROLES })).roles;

  test("the application's roles are kept apart; the others are module kinds, once each, checked later against the declaration", async () => {
    const r = await roles("api, views,outbox,views");
    expect([...r.app]).toEqual(["api"]);
    expect(r.modules).toEqual(["views", "outbox"]);
  });

  test("`all`, or blank, is every role and every module", async () => {
    for (const all of ["all", "", "  ", "views,all"]) {
      const r = await roles(all);
      expect([[...r.app], r.modules]).toEqual([["api"], "all"]);
    }
  });

  test("an application role alone runs no module", async () => {
    const r = await roles("api");
    expect([[...r.app], r.modules]).toEqual([["api"], []]);
  });

  test("an empty entry is refused, naming the variable", async () => {
    expect(await failure(wallet, { WALLET_ROLES: "api,,views" })).toContain('["WALLET"]["ROLES"]');
  });
});

describe("the parts, for an application that composes its own", () => {
  test("Crablet.config.database, .roles and .migrate read the same names under a prefix of the application's choosing", async () => {
    const own = Config.all({ db: Crablet.databaseConfig({ name: "own_db", username: "u", password: "p" }), roles: Crablet.rolesConfig(["api"]) }).pipe(Config.nested("OWN"));
    const s = await value(own, { OWN_DB_HOST: "h", OWN_ROLES: "views" });
    expect([s.db.pg.host, s.db.pg.database, s.roles.modules]).toEqual(["h", "own_db", ["views"]]);
  });
});

test("plainConnection gives the password in the clear, for a plain pg client", async () => {
  const s = await value(wallet, { WALLET_DB_PASSWORD: "s3cret" });
  expect(Crablet.plainConnection(s.pg)).toEqual({ host: "localhost", port: 5432, database: "wallet_db", username: "postgres", password: "s3cret" });
});

describe("Crablet.config: the product (decision V5)", () => {
  const named = Crablet.config("WALLET", { product: "wallet", database: { name: "wallet_db", username: "postgres", password: "postgres" } });
  test("the call names it; PRODUCT, under the prefix, overrides it; neither leaves the process unnamed", async () => {
    expect((await value(named)).options.product).toBe("wallet");
    expect((await value(named, { WALLET_PRODUCT: "wallet-eu" })).options.product).toBe("wallet-eu");
    expect((await value(wallet)).options.product).toBeUndefined();
  });

  test("a name with a slash, or blank, fails naming the variable (a connection is named <product>/<instance>)", async () => {
    expect(await failure(named, { WALLET_PRODUCT: "wallet/eu" })).toContain("PRODUCT");
    expect(await failure(named, { WALLET_PRODUCT: "  " })).toContain("PRODUCT");
  });
});
