import type { ProcessorManagementService } from "./ProcessorManagement.ts";

// One module's processors, as the application names them. `kind` is the word a client sees (views, automations, outbox, deadlines, or anything else);
// `service` is that module's management service. `describe` says what a processor is for.
export interface ProcessorSource {
  readonly kind: string;
  readonly service: ProcessorManagementService<string>;
  readonly describe?: ((id: string) => string | undefined) | undefined;
}
