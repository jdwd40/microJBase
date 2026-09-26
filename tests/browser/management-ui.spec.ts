// Browser smoke acceptance for the management UI (I1).
//
// Drives the real compiled server and real PostgreSQL through headless
// Chromium: sign-in gating and the 401 state, the memory-only token
// invariant, schema overview and table detail (columns / constraints /
// indexes / RLS / exposure), empty and populated history, the 429
// rate-limit state, the network-error state with retry, and a basic
// accessibility/responsive pass. Screenshots land in tests/browser/evidence/.
//
// Playwright re-runs top-level beforeAll hooks after a failed test, which
// re-provisions the database; every test below is therefore self-contained
// and never depends on seeded state from another test.
//
// Requires: npm run build (fresh dist), E2E_ADMIN_DATABASE_URL, chromium
// (npx playwright install chromium).

import { mkdirSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { E2E_ADMIN_TOKEN } from "../e2e/helpers/config.js"
import { nonce, type ApiClient, type ApiResponse } from "../e2e/helpers/http.js"
import { startE2EFile, stopE2EFile } from "../e2e/helpers/lifecycle.js"

const OP = E2E_ADMIN_TOKEN
const EVIDENCE = path.resolve("tests/browser/evidence")

interface SmokeContext {
  api: ApiClient
  baseUrl: string
  stop: () => Promise<void>
}

let smoke: SmokeContext

async function signIn(page: Page): Promise<void> {
  await page.goto(`${smoke.baseUrl}/admin/`)
  await page.getByLabel("Operator token").fill(OP)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(
    page.getByRole("heading", { name: "Schemas", exact: true }),
  ).toBeVisible()
}

function adminHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${OP}`,
    "content-type": "application/json",
    "idempotency-key": key,
  }
}

test.beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true })
  const context = await startE2EFile({ admin: true })
  smoke = {
    api: context.api,
    baseUrl: context.server.baseUrl,
    stop: async () => {
      await stopE2EFile(context)
    },
  }
})

test.afterAll(async () => {
  await smoke.stop()
})

test("sign-in gate, 401 state, and the memory-only token", async ({ page }) => {
  await page.goto(`${smoke.baseUrl}/admin/`)
  await expect(
    page.getByRole("heading", { name: "Operator sign-in" }),
  ).toBeVisible()
  await expect(page.getByLabel("Operator token")).toBeVisible()
  await page.screenshot({ path: `${EVIDENCE}/01-sign-in.png`, fullPage: true })

  // Wrong token: the frozen 401 INVALID_CREDENTIALS becomes an alert.
  await page.getByLabel("Operator token").fill("not-the-operator-token")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "rejected" }),
  ).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/02-401-state.png`,
    fullPage: true,
  })

  // Reloading destroys the session: gate again, and storage stayed empty.
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Operator sign-in" }),
  ).toBeVisible()
  const stored = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      localStorage: { length: number }
      sessionStorage: { length: number }
      document: { cookie: string }
    }
    return {
      localStorage: browser.localStorage.length,
      sessionStorage: browser.sessionStorage.length,
      cookies: browser.document.cookie,
    }
  })
  expect(stored.localStorage).toBe(0)
  expect(stored.sessionStorage).toBe(0)
  expect(stored.cookies).toBe("")
})

test("schema overview, empty history, and the exposed table detail", async ({
  page,
}) => {
  await signIn(page)

  // Overview: operator schemas, an empty schema, and the internal lane.
  const schemas = page.locator("section.panel", { has: page.locator("h2") })
  await expect(
    schemas.getByRole("heading", { name: "e2e_admin" }),
  ).toBeVisible()
  await expect(
    schemas.getByRole("heading", { name: "microjbase" }),
  ).toBeVisible()
  await expect(page.getByText("No tables in this schema.")).toBeVisible()
  await expect(page.getByText("Exposed as todos")).toBeVisible()

  // Table detail of the exposed table: RLS and exposure render.
  await page.getByRole("button", { name: "public.todos" }).click()
  await expect(
    page.getByRole("heading", { name: "public.todos" }),
  ).toBeVisible()
  await expect(page.getByText("Exposed as todos").first()).toBeVisible()
  await expect(page.getByText("Enabled, forced")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Columns" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Constraints" })).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/03-table-detail.png`,
    fullPage: true,
  })

  // History is still empty at this point — the empty state renders.
  await page.getByRole("link", { name: "History" }).click()
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("No operations recorded yet.")).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/04-history-empty.png`,
    fullPage: true,
  })
})

test("seeded table renders columns, constraints, indexes, and RLS state", async ({
  page,
}) => {
  // Seed a self-contained fixture through the frozen V02-18 surface.
  const run = nonce()
  const post = (
    path: string,
    body: unknown,
    key: string,
  ): Promise<ApiResponse> =>
    smoke.api.postWithHeaders(
      path,
      body,
      adminHeaders(`ui-smoke-${run}-${key}`),
    )
  const seeded: ApiResponse[] = []
  seeded.push(
    await post(
      "/v1/admin/schema/tables",
      {
        schema: "e2e_admin",
        table: "owners",
        columns: [
          {
            name: "name",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      "owners",
    ),
    await post(
      "/v1/admin/schema/tables",
      {
        schema: "e2e_admin",
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: false,
            default: { kind: "literal", value: "untitled" },
          },
          {
            name: "body",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      "tables",
    ),
    await post(
      "/v1/admin/schema/tables/e2e_admin/notes/columns",
      {
        column: {
          name: "todo_id",
          type: "uuid",
          nullable: true,
          default: { kind: "none" },
        },
      },
      "column",
    ),
    await post(
      "/v1/admin/schema/tables/e2e_admin/notes/foreign-keys",
      {
        columns: ["todo_id"],
        references: { schema: "e2e_admin", table: "owners", columns: ["id"] },
        on_update: "no_action",
        on_delete: "cascade",
      },
      "fk",
    ),
    await post(
      "/v1/admin/schema/tables/e2e_admin/notes/indexes",
      {
        columns: ["title"],
      },
      "index",
    ),
    await post(
      "/v1/admin/schema/tables/e2e_admin/notes/unique-constraints",
      {
        columns: ["title"],
      },
      "unique",
    ),
    await post(
      "/v1/admin/schema/rls/enable",
      {
        schema: "e2e_admin",
        table: "notes",
      },
      "rls",
    ),
  )
  for (const response of seeded) {
    expect(response.status, response.text).toBe(200)
  }

  await signIn(page)
  await page.getByRole("button", { name: "e2e_admin.notes" }).click()
  await expect(
    page.getByRole("heading", { name: "e2e_admin.notes" }),
  ).toBeVisible()

  // Columns section carries the added column and its uuid type; the managed
  // id column reports its generation default.
  const columns = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Columns" }),
  })
  const todoRow = columns.getByRole("row", { name: /todo_id/ })
  await expect(todoRow).toBeVisible()
  await expect(todoRow).toContainText("uuid")
  await expect(columns.getByRole("row", { name: /^id / })).toContainText(
    "gen_random_uuid()",
  )

  // Constraint section: primary key plus the foreign key with reference.
  const constraints = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Constraints" }),
  })
  await expect(constraints.getByText("notes_pkey")).toBeVisible()
  await expect(
    constraints.getByText(/References e2e_admin\.owners/),
  ).toBeVisible()
  await expect(constraints.getByText("CASCADE")).toBeVisible()

  // Standalone indexes exclude constraint-backed ones (contract rule).
  const indexes = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Indexes" }),
  })
  await expect(
    indexes.getByRole("row", { name: /notes_title_idx/ }),
  ).toBeVisible()

  // RLS is enabled and forced; the table is not exposed.
  await expect(page.getByText("Enabled, forced")).toBeVisible()
  await expect(page.getByText("Not exposed").first()).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/05-seeded-table.png`,
    fullPage: true,
  })
})

test("history lists recorded operations with status", async ({ page }) => {
  // Record two unique operations for this test and locate them by their
  // unique idempotency keys, independent of any other suite state.
  const run = nonce()
  const keyA = `ui-smoke-${run}-a`
  const keyB = `ui-smoke-${run}-b`
  const table = `hist${run}`
  const create = await smoke.api.postWithHeaders(
    "/v1/admin/schema/tables",
    {
      schema: "e2e_admin",
      table,
      columns: [
        { name: "t", type: "text", nullable: true, default: { kind: "none" } },
      ],
    },
    adminHeaders(keyA),
  )
  expect(create.status, create.text).toBe(200)
  const rls = await smoke.api.postWithHeaders(
    "/v1/admin/schema/rls/enable",
    { schema: "e2e_admin", table },
    adminHeaders(keyB),
  )
  expect(rls.status, rls.text).toBe(200)

  await signIn(page)
  await page.getByRole("link", { name: "History" }).click()
  const panel = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Operation history" }),
  })
  const rowA = panel.getByRole("row", { name: new RegExp(`${run}-a`) })
  const rowB = panel.getByRole("row", { name: new RegExp(`${run}-b`) })
  await expect(rowA).toContainText("schema.table.create")
  await expect(rowA).toContainText("Succeeded")
  await expect(rowB).toContainText("schema.rls.enable")
  await expect(rowB).toContainText("Succeeded")
  await expect(panel.getByRole("button", { name: "Previous" })).toBeDisabled()
  await expect(panel.getByRole("button", { name: "Next" })).toBeDisabled()
  await page.screenshot({ path: `${EVIDENCE}/06-history.png`, fullPage: true })
})

test("429 rate-limit state renders with an automatic retry countdown", async ({
  page,
}) => {
  await signIn(page)

  // Burn the per-endpoint history budget (30/IP/60s) outside the page.
  let lastStatus = 0
  for (let i = 0; i < 35; i += 1) {
    const response = await page.request.get(
      `${smoke.baseUrl}/v1/admin/schema/history`,
      { headers: { authorization: `Bearer ${OP}` } },
    )
    lastStatus = response.status()
  }
  expect(lastStatus).toBe(429)

  await page.getByRole("link", { name: "History" }).click()
  await expect(
    page.getByRole("heading", { name: "Rate limit exceeded" }),
  ).toBeVisible()
  await expect(page.getByText(/Retrying automatically in/)).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/07-rate-limited.png`,
    fullPage: true,
  })
})

test("network error state offers a working retry", async ({ page }) => {
  await page.route("**/v1/admin/schema", (route) => route.abort())
  await signIn(page) // the capabilities probe lives on a different path
  await page.getByRole("link", { name: "Schemas" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Something went wrong" }),
  ).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/08-error-state.png`,
    fullPage: true,
  })

  await page.unrouteAll()
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("heading", { name: "e2e_admin" })).toBeVisible()
})

test.describe("responsive and accessible shell", () => {
  test.use({ viewport: { width: 360, height: 720 } })

  test("landmarks, focus management, and keyboard navigation hold at 360px", async ({
    page,
  }) => {
    await page.goto(`${smoke.baseUrl}/admin/`)
    await expect(page.getByRole("banner")).toBeVisible()
    // Pre-authentication the app chrome stays hidden; only the gate shows.
    await expect(
      page.getByRole("navigation", { name: "Administration" }),
    ).toBeHidden()

    await page.getByLabel("Operator token").fill(OP)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(
      page.getByRole("navigation", { name: "Administration" }),
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Schemas", exact: true }),
    ).toBeVisible()

    // View changes move focus to the view heading for screen readers.
    await expect(page.locator("#view-heading")).toBeFocused()
    // The active nav item is exposed with aria-current.
    await expect(
      page.locator('a[data-nav="schemas"][aria-current="page"]'),
    ).toBeVisible()

    // Keyboard: from the focused heading, Tab moves into the content and
    // lands on the first schema's "Create table" action, then the first
    // table row button, whatever the seeded state is.
    await page.keyboard.press("Tab")
    await expect(
      page.getByRole("button", { name: "Create table" }).first(),
    ).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator("#main .row-button").first()).toBeFocused()

    await page.screenshot({ path: `${EVIDENCE}/09-mobile.png`, fullPage: true })
  })
})
