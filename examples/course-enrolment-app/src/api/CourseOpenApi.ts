import { OpenApi } from "effect/http-api";
import { makeCourseApi } from "../CourseApp.ts";

// The API's OpenAPI document as the text checked in at docs/api/course-enrolment-openapi.json. Produced from the same
// HttpApi the server serves, without starting anything.
export const courseOpenApiDocument = (): string => `${JSON.stringify(OpenApi.fromApi(makeCourseApi()), null, 2)}\n`;

export const courseOpenApiFile = new URL("../../../../docs/api/course-enrolment-openapi.json", import.meta.url);
