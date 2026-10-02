import type * as Schema from "effect/Schema";
import type { AnyDomainErrorClass } from "./Errors.ts";

// The PUBLIC part of a command: its name, its input Schema and the domain errors it can fail with. A transport (the HTTP API, its
// OpenAPI description, a client) needs only this and nothing of how a decision is made, so a module that declares the API from
// contracts can be bundled for a browser without `decide`, the models or the events. The behavior is added on the server by
// spreading the contract into `defineCommand`:
//
//     // enrolment.contract.ts  (no server imports)
//     export const SubscribeContract = commandContract({
//       name: "subscribe",
//       input: Schema.Struct({ studentId: Schema.String, courseId: Schema.String }),
//       errors: [CourseNotFound, CourseFull]
//     });
//
//     // Enrolment.ts  (the server)
//     export const Subscribe = defineCommand({ ...SubscribeContract, model: ..., decide: ... });
//
// Always declare a contract as its OWN const, as above. Writing the call inline inside the spread
// (`defineCommand({ ...commandContract({...}), decide })`) silently loosens the inferred error list, and `decide` could then fail
// with an error the contract does not declare without a compile error.
export interface CommandContract<
  Name extends string = string,
  I extends Schema.Constraint = Schema.Constraint,
  Es extends ReadonlyArray<AnyDomainErrorClass> = ReadonlyArray<AnyDomainErrorClass>
> {
  readonly name: Name;
  readonly input: I;
  readonly errors: Es;
}

export type AnyCommandContract = CommandContract;

export const commandContract = <
  const Name extends string,
  I extends Schema.Constraint,
  const Es extends ReadonlyArray<AnyDomainErrorClass> = readonly []
>(def: {
  readonly name: Name;
  readonly input: I;
  readonly errors?: Es;
}): CommandContract<Name, I, Es> => ({ name: def.name, input: def.input, errors: (def.errors ?? []) as unknown as Es });
