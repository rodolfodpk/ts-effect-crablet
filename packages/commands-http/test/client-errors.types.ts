// Compile-time tests (never executed): `matchDomainProblem` asks for exactly one handler per domain error of the union, typed by what that error declares.
import { isDomainProblem, matchDomainProblem, type DomainProblemsOf, type OtherErrorsOf } from "../src/ClientErrors.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface CourseFull { readonly errorType: "CourseFull"; readonly detail: string; readonly fields: { readonly courseId: string; readonly capacity: number } }
interface CourseNotFound { readonly errorType: "CourseNotFound"; readonly detail: string; readonly fields: { readonly courseId: string } }
interface Rejected { readonly title: string; readonly detail: string }
class TransportError { readonly _tag = "TransportError" }
type CallError = CourseFull | CourseNotFound | Rejected | TransportError;

declare const error: CallError;

export type SplitsTheUnion = [
  Equal<DomainProblemsOf<CallError>, CourseFull | CourseNotFound>,
  Equal<OtherErrorsOf<CallError>, Rejected | TransportError>
];
export const splits: SplitsTheUnion = [true, true];

// the guard narrows to the domain errors
if (isDomainProblem(error)) {
  const narrowed: CourseFull | CourseNotFound = error;
  void narrowed;
}

// every domain error has its handler, typed by its own fields; `otherwise` gets only what is not one
export const meaning: string = matchDomainProblem(
  error,
  {
    CourseFull: ({ fields }) => `full at ${fields.capacity}`,
    CourseNotFound: ({ fields }) => `no ${fields.courseId}`
  },
  (other: Rejected | TransportError) => ("title" in other ? other.title : other._tag)
);

// @ts-expect-error CourseNotFound has no handler
matchDomainProblem(error, { CourseFull: () => 1 }, () => 0);

matchDomainProblem(
  error,
  {
    CourseFull: () => 1,
    CourseNotFound: () => 1,
    // @ts-expect-error DiskFull is not a domain error of this union
    DiskFull: () => 1
  },
  () => 0
);

matchDomainProblem(
  error,
  {
    // @ts-expect-error CourseFull has `capacity` and `courseId`, not `studentId`
    CourseFull: ({ fields }) => fields.studentId,
    CourseNotFound: () => 1
  },
  () => 0
);

// a union with no domain error needs no handler
declare const plain: Rejected | TransportError;
export const noDomainErrors: number = matchDomainProblem(plain, {}, () => 0);
