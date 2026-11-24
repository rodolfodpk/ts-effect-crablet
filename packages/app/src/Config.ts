import { Config, Option, Redacted, Schema } from "effect";
import { polling as pollingConfig, type PollingFromConfig } from "@crablet/event-poller/Config";
import { wakeups as wakeupsConfig } from "@crablet/eventstore/Config";

// One process's settings, read from its configuration (the environment, by default) under the product's prefix: what `Crablet.layer`,
// `Crablet.processors` and the start-up need. Each part has its owner: the connection here, beside the `layer` that opens it; the polling in
// @crablet/event-poller; the wake-ups in @crablet/eventstore. A failure is a `ConfigError` that names the variable.

// A connection, as `Crablet.layer` takes it (`PgConfig`), with a password that does not show when printed.
export interface Connection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
  readonly maxConnections?: number;
}

// The connection with its password in the clear, for what takes a plain `pg` client (`migrate` from @crablet/db-migrations/Migrate). Keep it out of logs.
export const plainConnection = (connection: Connection) => ({
  host: connection.host,
  port: connection.port,
  database: connection.database,
  username: connection.username,
  password: Redacted.value(connection.password)
});

// What the call gives for what the environment may leave unset. Without them, the database's name, user and password must be set; the host defaults
// to localhost and the port to 5432.
export interface DatabaseDefaults {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly name?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
}

const SESSION_POOL = 10;

const atLeastOne = (name: string) => Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), name);
const withFallback = <A>(config: Config.Config<A>, fallback: A | undefined): Config.Config<A> =>
  fallback === undefined ? config : config.pipe(Config.withDefault(fallback));
const optional = <A>(config: Config.Config<A>): Config.Config<A | undefined> => config.pipe(Config.option, Config.map(Option.getOrUndefined));

// DB_URL, as a platform gives it (postgres://user:password@host:port/database). When set, it wins over the parts.
const postgresUrl = Schema.URL.check(
  Schema.makeFilter((url: URL) =>
    url.protocol !== "postgres:" && url.protocol !== "postgresql:"
      ? "a postgres:// URL"
      : url.pathname.length <= 1
        ? "a URL that names the database (postgres://host/database)"
        : true
  )
);
const fromUrl = (url: URL, password: Redacted.Redacted<string>) => ({
  host: decodeURIComponent(url.hostname),
  port: url.port === "" ? 5432 : Number(url.port),
  database: decodeURIComponent(url.pathname.slice(1)),
  username: decodeURIComponent(url.username),
  password
});

const parts = (defaults: DatabaseDefaults) =>
  Config.all({
    host: withFallback(Config.String("DB_HOST"), defaults.host ?? "localhost"),
    port: withFallback(Config.Port("DB_PORT"), defaults.port ?? 5432),
    database: withFallback(Config.String("DB_NAME"), defaults.name),
    username: withFallback(Config.String("DB_USER"), defaults.username),
    password: withFallback(Config.Redacted("DB_PASSWORD"), defaults.password === undefined ? undefined : Redacted.make(defaults.password))
  });

const withPool = (connection: Omit<Connection, "maxConnections">, pool: number | undefined): Connection =>
  pool === undefined ? connection : { ...connection, maxConnections: pool };

// The main connection (DB_URL, or DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD; DB_POOL, at least 1, unset for the library's default), and the
// direct session connection for the leader locks and LISTEN when DB_SESSION_HOST is set (each DB_SESSION_* part falls back to the main one,
// DB_SESSION_POOL to 10). See docs/guides/operate/run-in-production.md.
export const databaseConfig = (defaults: DatabaseDefaults = {}): Config.Config<{ readonly pg: Connection; readonly session: Connection | undefined }> =>
  Config.all({
    url: optional(Config.schema(postgresUrl, "DB_URL")),
    pool: optional(atLeastOne("DB_POOL")),
    sessionHost: optional(Config.String("DB_SESSION_HOST"))
  }).pipe(
    Config.flatMap(({ url, pool, sessionHost }) =>
      Config.map(
        url === undefined ? parts(defaults) : Config.succeed(fromUrl(url, Redacted.make(decodeURIComponent(url.password)))),
        (main) => ({ main, pool, sessionHost })
      )
    ),
    Config.flatMap(({ main, pool, sessionHost }): Config.Config<{ readonly pg: Connection; readonly session: Connection | undefined }> =>
      sessionHost === undefined
        ? Config.succeed({ pg: withPool(main, pool), session: undefined })
        : Config.map(
            Config.all({
              port: withFallback(Config.Port("DB_SESSION_PORT"), main.port),
              database: withFallback(Config.String("DB_SESSION_NAME"), main.database),
              username: withFallback(Config.String("DB_SESSION_USER"), main.username),
              password: withFallback(Config.Redacted("DB_SESSION_PASSWORD"), main.password),
              pool: withFallback(atLeastOne("DB_SESSION_POOL"), SESSION_POOL)
            }),
            ({ pool: sessionPool, ...session }) => ({ pg: withPool(main, pool), session: withPool({ host: sessionHost, ...session }, sessionPool) })
          )
    )
  );

// What one process does (ADR-0022). ROLES is a comma-separated list; unset, blank or containing `all`, the process does everything. The application's
// own roles (those given to `rolesConfig`, such as `api`) are kept apart; every other name is a module kind, which `Crablet.processorsFor` checks
// against the declaration (`UnknownRole`): the configuration does not know the modules, so a new kind of module needs no change here.
export interface Roles<AppRole extends string> {
  // The application's roles this process has, out of `declared`.
  readonly app: ReadonlySet<AppRole>;
  readonly declared: ReadonlyArray<AppRole>;
  // The module kinds to run, unchecked, or "all" of those declared.
  readonly modules: ReadonlyArray<string> | "all";
}

const entry = Schema.Trim.check(Schema.isNonEmpty());

export const rolesConfig = <const AppRole extends string = never>(declared: ReadonlyArray<AppRole> = []): Config.Config<Roles<AppRole>> =>
  Config.String("ROLES").pipe(
    Config.withDefault(""),
    Config.flatMap((raw) => (raw.trim() === "" ? Config.succeed<ReadonlyArray<string>>(["all"]) : Config.Array(entry, "ROLES"))),
    Config.map((names): Roles<AppRole> => {
      if (names.includes("all")) return { app: new Set(declared), declared, modules: "all" };
      const app = new Set(declared.filter((role) => names.includes(role)));
      return { app, declared, modules: [...new Set(names.filter((name) => !declared.some((role) => role === name)))] };
    })
  );

// MIGRATE: whether the process applies the schema at start-up (`on`, the default) or leaves it to a pre-deploy job (`off`, as it must be when several
// instances start together: ADR-0022, decision 6).
export const migrateConfig: Config.Config<boolean> = Config.Literals(["on", "off"], "MIGRATE").pipe(
  Config.withDefault("on" as const),
  Config.map((value) => value === "on")
);

export interface Settings<AppRole extends string> {
  // `Crablet.layer(settings.pg, settings.options)`.
  readonly pg: Connection;
  readonly options: { readonly eventStore: { readonly wakeupMode: "coalesced" | "off" }; readonly session?: Connection };
  // `Crablet.processorsFor(declaration, settings.roles, { polling: settings.polling })`.
  readonly polling: PollingFromConfig;
  readonly roles: Roles<AppRole>;
  readonly migrate: boolean;
}

export interface ConfigOptions<AppRole extends string> {
  // The application's own roles, beside the module kinds (the wallet: ["api"]).
  readonly roles?: ReadonlyArray<AppRole> | undefined;
  readonly database?: DatabaseDefaults | undefined;
}

// Every part, under `prefix` (the product: WALLET_DB_HOST, WALLET_ROLES...). An application with names of its own composes the parts instead
// (`databaseConfig`, `rolesConfig`, `migrateConfig`, and `polling` and `wakeups` from their packages).
export const config = <const AppRole extends string = never>(prefix: string, options: ConfigOptions<AppRole> = {}): Config.Config<Settings<AppRole>> =>
  Config.all({
    database: databaseConfig(options.database),
    wakeupMode: wakeupsConfig,
    polling: pollingConfig,
    roles: rolesConfig<AppRole>(options.roles),
    migrate: migrateConfig
  }).pipe(
    Config.map(({ database, wakeupMode, polling, roles, migrate }) => ({
      pg: database.pg,
      options: database.session === undefined ? { eventStore: { wakeupMode } } : { eventStore: { wakeupMode }, session: database.session },
      polling,
      roles,
      migrate
    })),
    Config.nested(prefix)
  );
