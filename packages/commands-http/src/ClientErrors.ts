// Reading what a typed client fails with. A client derived from the API (`HttpApiClient.make(makeCourseApi())`, as a Foldkit page builds one) fails a command with a
// union: the domain errors that command declares, each as its problem body (told apart by `errorType`, with exactly the `fields` that error declares), beside the
// framework's problems (a 400, a 409, a 500), a transport error and a `SchemaError`. This module narrows that union by the domain error, and nothing else.
//
// It imports nothing: a page that is bundled for a browser can import it (test/browser-safe.test.ts of the course app checks that).
//
//     const problem = matchDomainProblem(error, {
//       CourseFull: ({ fields }) => ({ _tag: "CourseFull", capacity: fields.capacity }),
//       CourseNotFound: ({ fields }) => ({ _tag: "CourseNotFound", courseId: fields.courseId })
//     }, (other) => ({ _tag: "Unreachable" }));
//
// There is exactly one handler per domain error the union declares: when a command gains a declared error, every `matchDomainProblem` over its errors stops
// compiling until it says what to do with it (the same promise the server makes: a command cannot fail with an error its contract does not declare).

// A problem body of a domain error: what the server answers with, and what the derived client decodes it to.
export interface DomainProblem {
  readonly errorType: string;
}

// The members of an error union that are a domain error's problem body.
export type DomainProblemsOf<E> = Extract<E, DomainProblem>;

// Everything else the union holds: the framework's problems, the transport's error, a `SchemaError`.
export type OtherErrorsOf<E> = Exclude<E, DomainProblem>;

// One handler per domain error of the union, by its `errorType`. Each takes that error's own problem body, so `fields` is typed by what the error declares.
// (A plain mapped type over the `errorType`s, not a key-remapped one: only this form gives the handlers' parameters their type from the call.)
export type DomainProblemHandlers<E, R> = {
  readonly [T in DomainProblemsOf<E>["errorType"]]: (problem: Extract<DomainProblemsOf<E>, { readonly errorType: T }>) => R;
};

const hasErrorType = (value: unknown): value is DomainProblem =>
  typeof value === "object" && value !== null && "errorType" in value && typeof value.errorType === "string";

// Is this error a domain error's problem body? Narrows a union to its domain errors.
export const isDomainProblem = <E>(error: E): error is DomainProblemsOf<E> => hasErrorType(error);

// What an error means, by the domain error it is, or by `otherwise` when it is not one (a framework problem, the transport, a `SchemaError`).
export function matchDomainProblem<E, R, O>(error: E, handlers: DomainProblemHandlers<E, R>, otherwise: (other: OtherErrorsOf<E>) => O): R | O;
export function matchDomainProblem(
  error: unknown,
  handlers: Readonly<Record<string, (problem: DomainProblem) => unknown>>,
  otherwise: (other: unknown) => unknown
): unknown {
  if (hasErrorType(error)) {
    const handler = handlers[error.errorType];
    // A problem the types do not know (a server newer than the page) has no handler: it is handled as any other error.
    if (handler !== undefined) return handler(error);
  }
  return otherwise(error);
}
