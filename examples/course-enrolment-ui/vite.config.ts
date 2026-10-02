import { defineConfig } from "vite";

// #region proxy
// The course API (examples/course-enrolment-app) listens on :8080. Proxying it makes the page and the API ONE origin in
// the browser, so the server needs no CORS handling.
const api = `http://localhost:${process.env["PORT"] ?? 8080}`;

export default defineConfig({
  // one copy of effect: the page and the course app's API definition (imported below) must share its Schema classes
  resolve: { dedupe: ["effect"] },
  server: { proxy: { "/api": api, "/openapi.json": api } }
});
// #endregion proxy
