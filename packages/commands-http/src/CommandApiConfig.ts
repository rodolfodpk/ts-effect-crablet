// Both fields are optional: basePath defaults to "/api/commands", correlation header handling is off
// unless explicitly enabled.
export interface CommandApiConfig {
  readonly basePath?: string;
  readonly correlationHeaderEnabled?: boolean;
}

export const defaultBasePath = "/api/commands";
