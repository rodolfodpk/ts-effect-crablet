import { defineConfig } from "vite";

// #region proxy
// The application whose processors this page administers (any Crablet application that mounts @crablet/processors-http; the wallet example does when
// WALLET_ADMIN_TOKEN is set) listens on :8080. Proxying `/admin` makes the page and the API ONE origin in the browser, so the server needs no CORS handling.
// To call it on its own origin instead, set VITE_API_URL (the API then needs CORS for this page's origin).
const api = process.env["ADMIN_API_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8080}`;

export default defineConfig({
  // one copy of effect: the page and the admin API definition (imported from @crablet/processors-http) must share its Schema classes
  resolve: { dedupe: ["effect"] },
  server: { proxy: { "/admin": api } }
});
// #endregion proxy
