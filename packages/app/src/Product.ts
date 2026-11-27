import { Context } from "effect";

// Who this process is (decision V5): the product it belongs to and its instance, set once by `Crablet.layer(pg, { product })`. It names the
// process's connections (`application_name` is `<product>/<instance>`, what `pg_stat_activity` shows), it is the instance id of its modules, and the
// modules' leaders report a lock held by another product's session (`LeaderOptions.application`, @crablet/eventstore/Leader). It lives here, beside
// the layer that opens the connections: the event store takes only the name, as a parameter, and knows no product.
//
// A `Context.Reference` with no identity by default: a process (or a test) built without a product names nothing and looks nothing up.
export interface ProcessIdentity {
  readonly product: string;
  readonly instance: string;
}

export const ProcessIdentityRef = Context.Reference<ProcessIdentity | null>("crablet/ProcessIdentity", { defaultValue: () => null });

// What `pg_stat_activity.application_name` shows for the process's connections. Postgres keeps 63 bytes of it.
export const applicationNameOf = (identity: ProcessIdentity): string => `${identity.product}/${identity.instance}`;

// A product name names connections and is matched as the part before the "/": it may not be empty or hold one.
export const isProductName = (name: string): boolean => name.trim() !== "" && !name.includes("/");
