// Regenerates docs/api/course-enrolment-openapi.json:   node scripts/generate-openapi.ts   (from this package)
// Run it after changing a command, its input, its declared errors or an endpoint; the unit test fails until the
// checked-in file matches.
import { writeFileSync } from "node:fs";
import { courseOpenApiDocument, courseOpenApiFile } from "../src/api/CourseOpenApi.ts";

writeFileSync(courseOpenApiFile, courseOpenApiDocument());
console.log(`wrote ${courseOpenApiFile.pathname}`);
