import type * as Crablet from "@crablet/app";

// What one process of the wallet does (ADR-0022): WALLET_ROLES, read by `Crablet.config` (src/config.ts). Unset, blank or `all` is the single process
// that starts everything. Roles talk to each other only through Postgres, so any combination can run as one process or as separate deployments of the
// same image. (Until the wallet moves onto `Crablet.processorsFor`, phase 3, it checks its module roles here.)
export const ROLES = ["api", "views", "automations", "outbox"] as const;
export type Role = (typeof ROLES)[number];
export type Roles = ReadonlySet<Role>;

export const allRoles: Roles = new Set(ROLES);
export const workerRoles = ["views", "automations", "outbox"] as const satisfies ReadonlyArray<Role>;

// The wallet's roles from what the configuration read: `api` as it came, each module kind checked. An unknown one stops the start-up.
export const rolesOf = (configured: Crablet.Roles<"api">): Roles => {
  if (configured.modules === "all") return allRoles;
  const roles = new Set<Role>(configured.app);
  for (const name of configured.modules) {
    const worker = workerRoles.find((r) => r === name);
    if (worker === undefined) throw new Error(`WALLET_ROLES must be a comma-separated list of ${ROLES.join(", ")} or all; "${name}" is not a role`);
    roles.add(worker);
  }
  return roles;
};

// A process with any worker role runs processors and so has handles, samplers and a lock to release; one with only `api` has none.
export const hasWorkers = (roles: Roles): boolean => workerRoles.some((r) => roles.has(r));
