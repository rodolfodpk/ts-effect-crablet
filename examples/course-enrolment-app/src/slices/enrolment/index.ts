// The enrolment slice: a course is defined, and a student subscribes to it (two rules, one decision). Its commands are served over HTTP
// (CourseApp.ts); its public contracts are in enrolment.contract.ts, which a browser imports directly (not through this file, which carries the rules).
export * from "./Enrolment.ts";
