import { defineConfig } from "vite";

// The page talks to the lab server (server/server.ts, on 127.0.0.1:5174). Proxying `/api` makes the page and the server ONE origin in the browser, so the server needs no CORS.
// 127.0.0.1 and not `localhost`: the server listens on IPv4 only, and `localhost` can resolve to IPv6.
const server = process.env["CHAOS_SERVER_URL"] ?? "http://127.0.0.1:5174";

export default defineConfig({
  resolve: { dedupe: ["effect"] },
  server: { port: 5175, proxy: { "/api": server } }
});
