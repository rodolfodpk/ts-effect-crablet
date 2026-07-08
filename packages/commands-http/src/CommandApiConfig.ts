// Port of com.crablet.command.web.CommandApiProperties (crablet.commands.api.* properties).
// Both fields default to matching Java's own defaults - basePath "/api/commands", correlation
// header handling off unless explicitly enabled.
export interface CommandApiConfig {
  readonly basePath?: string;
  readonly correlationHeaderEnabled?: boolean;
}

export const defaultBasePath = "/api/commands";
