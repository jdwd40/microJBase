// Playwright configuration for the management UI browser smoke suite.
//
// The specs provision their own database and compiled server (reusing the
// E2E helpers), so no webServer entry is needed here; @playwright/test only
// drives the browser. Run with:
//
//   E2E_ADMIN_DATABASE_URL=postgres://<admin>@<host>:<port>/postgres \
//     npm run test:browser

import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"]],
})
