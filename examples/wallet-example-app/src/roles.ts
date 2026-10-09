// What one process of the wallet does (ADR-0022). WALLET_ROLES is a comma-separated list of the four roles, or `all`; unset or blank means `all`, which is the single process
// that starts everything. Roles talk to each other only through Postgres, so any combination can run as one process or as separate deployments of the same image.
export const ROLES = ["api", "views", "automations", "outbox"] as const;
export type Role = (typeof ROLES)[number];
export type Roles = ReadonlySet<Role>;

export const allRoles: Roles = new Set(ROLES);
export const workerRoles = ["views", "automations", "outbox"] as const satisfies ReadonlyArray<Role>;

export const rolesFromEnv = (value: string | undefined = process.env["WALLET_ROLES"]): Roles => {
  if (value === undefined || value.trim() === "") return allRoles;
  const roles = new Set<Role>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "all") ROLES.forEach((r) => roles.add(r));
    else if ((ROLES as ReadonlyArray<string>).includes(entry)) roles.add(entry as Role);
    else throw new Error(`WALLET_ROLES must be a comma-separated list of ${ROLES.join(", ")} or all, got "${value}"${entry === "" ? " (an empty entry)" : ` ("${entry}" is not a role)`}`);
  }
  return roles;
};

// A process with any worker role runs processors and so has handles, samplers and a lock to release; one with only `api` has none.
export const hasWorkers = (roles: Roles): boolean => workerRoles.some((r) => roles.has(r));
