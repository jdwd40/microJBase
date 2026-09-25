// Browser acceptance for the management UI mutation workflows (I2, V02-18).
//
// Drives the real compiled server and real PostgreSQL through headless
// Chromium: typed create/edit flows with mandatory dry-run previews, the
// expose/unexpose lifecycle, destructive flows with exact confirmations,
// sanitized server errors, auth isolation from ordinary session tokens, and
// an accessibility/keyboard pass over the mutation forms.
//
// Every test is self-contained: fixtures are seeded through the frozen
// V02-18 surface with unique names, so no test depends on another. Run with
// E2E_ADMIN_DATABASE_URL=... npm run test:browser after npm run build.

import { mkdirSync } from "node:fs"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { E2E_ADMIN_TOKEN } from "../e2e/helpers/config.js"
import {
  createApi,
  nonce,
  registerUser,
  type ApiClient,
  type ApiResponse,
} from "../e2e/helpers/http.js"
import { startE2EFile, stopE2EFile } from "../e2e/helpers/lifecycle.js"

const OP = E2E_ADMIN_TOKEN
const EVIDENCE = path.resolve("tests/browser/evidence")

interface MutationContext {
  api: ApiClient
  baseUrl: string
  stop: () => Promise<void>
  post: (path: string, body: unknown, key: string) => Promise<ApiResponse>
}

let ctx: MutationContext

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ctx.baseUrl}/admin/`)
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

/** Seed one table with a single nullable text column through the admin API. */
async function seedTable(run: string, name: string): Promise<void> {
  const response = await ctx.post(
    "/v1/admin/schema/tables",
    {
      schema: "e2e_admin",
      table: name,
      columns: [
        {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      ],
    },
    `ui-e2e-${run}-${name}`,
  )
  expect(response.status, response.text).toBe(200)
}

async function openTable(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `e2e_admin.${name}` }).click()
  await expect(page.locator("#table-summary-heading")).toHaveText(
    `e2e_admin.${name}`,
  )
}

test.beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true })
  const context = await startE2EFile({ admin: true })
  ctx = {
    api: createApi(context.server.baseUrl),
    baseUrl: context.server.baseUrl,
    stop: async () => {
      await stopE2EFile(context)
    },
    post: (path, body, key) =>
      context.api.postWithHeaders(path, body, adminHeaders(key)),
  }
})

test.afterAll(async () => {
  await ctx.stop()
})

test("create table: dry-run preview, apply, refresh, history", async ({
  page,
}) => {
  const run = nonce()
  const table = `crt${run}`
  await signIn(page)

  const section = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "e2e_admin" }),
  })
  await section.getByRole("button", { name: "Create table" }).click()
  await expect(page.locator("#mutation-heading")).toHaveText(
    "Create table in e2e_admin",
  )
  await expect(page.getByLabel("Schema")).toHaveValue("e2e_admin")

  // One idempotency key per form, shown read-only.
  const keyInput = page.getByLabel("Idempotency key")
  await expect(keyInput).toHaveAttribute("readonly", "")
  await expect(keyInput).toHaveValue(/^ui-[0-9a-f-]{36}$/)

  await page.getByLabel("Table name").fill(table)
  const row = page.locator("[data-column-row]")
  await row.getByLabel("Column name").fill("title")
  await row.getByLabel("Nullable").check()

  // Apply stays disabled until a dry run succeeds for the current values.
  const apply = page.getByRole("button", { name: "Apply change" })
  await expect(apply).toBeDisabled()
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await expect(page.getByText(/nothing changed/)).toBeVisible()
  await expect(apply).toBeEnabled()

  // Editing after the preview invalidates it again.
  await page.getByLabel("Table name").fill(`${table}x`)
  await expect(apply).toBeDisabled()
  await page.getByLabel("Table name").fill(table)
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(apply).toBeEnabled()

  await apply.click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(page.locator("#table-summary-heading")).toHaveText(
    `e2e_admin.${table}`,
  )
  const columns = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Columns" }),
  })
  await expect(columns.getByRole("row", { name: /^title / })).toBeVisible()
  await expect(columns.getByRole("row", { name: /^id / })).toContainText(
    "gen_random_uuid()",
  )
  await page.screenshot({
    path: `${EVIDENCE}/10-create-table.png`,
    fullPage: true,
  })

  // The operation is durable history.
  await page.getByRole("link", { name: "History" }).click()
  const historyPanel = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Operation history" }),
  })
  await expect(
    historyPanel.getByRole("row", { name: /schema\.table\.create/ }),
  ).toContainText("Succeeded")
  await page.screenshot({
    path: `${EVIDENCE}/11-create-history.png`,
    fullPage: true,
  })
})

test("edit flows: add column and rename table", async ({ page }) => {
  const run = nonce()
  const table = `edit${run}`
  const renamed = `renamed${run}`
  await seedTable(run, table)
  await signIn(page)

  await openTable(page, table)
  await page.getByRole("button", { name: "Add column" }).click()
  await expect(page.locator("#mutation-heading")).toHaveText(
    `Add column to e2e_admin.${table}`,
  )
  await page.getByLabel("Column name").fill("body")
  await page.getByLabel("Nullable").check()
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  const columns = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Columns" }),
  })
  await expect(columns.getByRole("row", { name: /^body / })).toBeVisible()

  await page.getByRole("button", { name: "Rename table" }).click()
  await page.getByLabel("New table name").fill(renamed)
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(page.locator("#table-summary-heading")).toHaveText(
    `e2e_admin.${renamed}`,
  )
  await page.screenshot({
    path: `${EVIDENCE}/12-edit-flows.png`,
    fullPage: true,
  })
})

test("expose and unexpose through the UI", async ({ page }) => {
  const run = nonce()
  const table = `docs${run}`
  const alias = `docs${run}`

  // Seed an expose-ready table: uuid ownership column, forced RLS, and the
  // four module-owned ownership policies the exposure check requires.
  const created = await ctx.post(
    "/v1/admin/schema/tables",
    {
      schema: "e2e_admin",
      table,
      columns: [
        {
          name: "owner_id",
          type: "uuid",
          nullable: true,
          default: { kind: "none" },
        },
      ],
    },
    `ui-e2e-${run}-table`,
  )
  expect(created.status, created.text).toBe(200)
  const rls = await ctx.post(
    "/v1/admin/schema/rls/enable",
    { schema: "e2e_admin", table },
    `ui-e2e-${run}-rls`,
  )
  expect(rls.status, rls.text).toBe(200)
  for (const template of ["read", "insert", "update", "delete"] as const) {
    const policy = await ctx.post(
      "/v1/admin/schema/policies",
      { schema: "e2e_admin", table, column: "owner_id", template },
      `ui-e2e-${run}-policy-${template}`,
    )
    expect(policy.status, policy.text).toBe(200)
  }

  await signIn(page)
  await openTable(page, table)

  await page.getByRole("button", { name: "Expose table" }).click()
  await page.getByLabel("Data API alias").fill(alias)
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(page.getByText(`Exposed as ${alias}`).first()).toBeVisible()
  // Structural changes are unavailable while exposed; unexpose is offered.
  await expect(page.getByRole("button", { name: "Rename table" })).toHaveCount(
    0,
  )
  await page.screenshot({
    path: `${EVIDENCE}/13-exposed.png`,
    fullPage: true,
  })

  await page.getByRole("button", { name: "Unexpose table" }).click()
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(page.getByText("Not exposed").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Expose table" })).toBeVisible()
  await page.screenshot({
    path: `${EVIDENCE}/14-unexposed.png`,
    fullPage: true,
  })
})

test("destructive flows require the exact confirmation", async ({ page }) => {
  const run = nonce()
  const table = `drop${run}`
  const columnResponse = await ctx.post(
    "/v1/admin/schema/tables",
    {
      schema: "e2e_admin",
      table,
      columns: [
        {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
        {
          name: "body",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      ],
    },
    `ui-e2e-${run}-table`,
  )
  expect(columnResponse.status, columnResponse.text).toBe(200)

  await signIn(page)
  await openTable(page, table)

  // Drop column: a wrong confirmation is refused client-side before any
  // request, the exact value dry-runs and then applies.
  const columns = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "Columns" }),
  })
  const bodyRow = columns.getByRole("row", { name: /^body / })
  await bodyRow.getByRole("button", { name: "Drop", exact: true }).click()
  await expect(page.locator("#mutation-heading")).toHaveText("Drop column body")
  await expect(page.getByText(/Exact value:/)).toContainText(
    `e2e_admin.${table}.body`,
  )
  await page.getByLabel(/exact column path/).fill("not-the-right-value")
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "confirmation does not match" }),
  ).toBeVisible()

  await page.getByLabel(/exact column path/).fill(`e2e_admin.${table}.body`)
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(columns.getByRole("row", { name: /^body / })).toHaveCount(0)

  // Drop table: exact confirmation, then the overview refresh shows it gone.
  await page.getByRole("button", { name: "Drop table" }).click()
  await page.getByLabel(/exact table name/).fill(`e2e_admin.${table}`)
  await page.getByRole("button", { name: "Dry run" }).click()
  await expect(
    page.locator(".banner-preview").getByText("Dry run succeeded."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Apply change" }).click()
  await expect(
    page.locator(".banner-success").getByText("Change applied."),
  ).toBeVisible()
  await expect(page.locator("#view-heading")).toHaveText("Schemas")
  await expect(
    page.getByRole("button", { name: `e2e_admin.${table}` }),
  ).toHaveCount(0)
  await page.screenshot({
    path: `${EVIDENCE}/15-drop-table.png`,
    fullPage: true,
  })
})

test("server failures render only the sanitized envelope", async ({ page }) => {
  const run = nonce()
  const table = `dup${run}`
  await seedTable(run, table)
  await signIn(page)

  // Creating the same table again fails in the dry run with the frozen safe
  // envelope: a stable code and a safe message, never SQL internals.
  const section = page.locator("section.panel", {
    has: page.getByRole("heading", { name: "e2e_admin" }),
  })
  await section.getByRole("button", { name: "Create table" }).click()
  await page.getByLabel("Table name").fill(table)
  await page.locator("[data-column-row]").getByLabel("Column name").fill("x")
  await page.getByRole("button", { name: "Dry run" }).click()
  const failure = page.locator(".banner-error")
  await expect(failure).toBeVisible()
  await expect(failure).toContainText("CONFLICT.")
  await expect(failure).not.toContainText("SQLSTATE")
  await expect(failure).not.toContainText("pg_catalog")
  await page.screenshot({
    path: `${EVIDENCE}/16-sanitized-error.png`,
    fullPage: true,
  })
})

test("auth isolation: ordinary session tokens cannot use the admin UI", async ({
  page,
}) => {
  const run = nonce()
  const user = await registerUser(ctx.api, `ordinary-${run}@example.com`)

  // Direct API proof: an ordinary session token gets the frozen
  // 401 INVALID_CREDENTIALS on a mutation endpoint, not an auth bypass.
  const direct = await ctx.api.postWithHeaders(
    "/v1/admin/schema/rls/enable",
    { schema: "e2e_admin", table: "anything" },
    {
      authorization: `Bearer ${user.token}`,
      "content-type": "application/json",
      "idempotency-key": `ui-e2e-${run}-direct`,
    },
  )
  expect(direct.status).toBe(401)
  expect((direct.body as { error: { code: string } }).error.code).toBe(
    "INVALID_CREDENTIALS",
  )

  // UI proof: the same token is rejected at the sign-in gate.
  await page.goto(`${ctx.baseUrl}/admin/`)
  await page.getByLabel("Operator token").fill(user.token)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "rejected" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Operator sign-in" }),
  ).toBeVisible()
})

test.describe("accessible mutation forms", () => {
  test.use({ viewport: { width: 360, height: 720 } })

  test("labels, focus management, live announcements, and keyboard apply", async ({
    page,
  }) => {
    const run = nonce()
    const table = `a11y${run}`
    await seedTable(run, table)
    await signIn(page)
    await openTable(page, table)

    await page.getByRole("button", { name: "Add column" }).click()
    // View changes move focus to the heading for screen readers.
    await expect(page.locator("#view-heading")).toBeFocused()
    await expect(page.locator("#view-heading")).toContainText(
      `Add column to e2e_admin.${table}`,
    )
    // Every control is labelled.
    await expect(page.getByLabel("Column name")).toBeVisible()
    await expect(page.getByLabel("Type")).toBeVisible()
    await expect(page.getByLabel("Nullable")).toBeVisible()
    await expect(page.getByLabel("Default", { exact: true })).toBeVisible()
    await expect(page.getByLabel("Idempotency key")).toBeVisible()

    // Keyboard: Tab moves from the heading into the form content.
    await page.keyboard.press("Tab")
    await expect(
      page.getByRole("link", { name: /Back to e2e_admin/ }),
    ).toBeFocused()

    await page.getByLabel("Column name").fill("note_body")
    await page.getByLabel("Nullable").check()
    await page.getByRole("button", { name: "Dry run" }).click()
    // The preview banner takes focus and the live region announces it.
    await expect(page.locator(".banner-preview")).toBeFocused()
    await expect(page.locator("#view-status")).toContainText(
      "Dry run succeeded",
    )

    // The whole flow is keyboard-operable: Enter on the apply button applies.
    await page.getByRole("button", { name: "Apply change" }).press("Enter")
    await expect(
      page.locator(".banner-success").getByText("Change applied."),
    ).toBeVisible()
    const columns = page.locator("section.panel", {
      has: page.getByRole("heading", { name: "Columns" }),
    })
    await expect(
      columns.getByRole("row", { name: /^note_body / }),
    ).toBeVisible()

    // The form layout fits the 360px viewport.
    const overflow = await page.evaluate(() => {
      const browsing = globalThis as unknown as {
        document: { scrollingElement: { scrollWidth: number } | null }
      }
      return browsing.document.scrollingElement?.scrollWidth ?? 0
    })
    expect(overflow).toBeLessThanOrEqual(360)
    await page.screenshot({
      path: `${EVIDENCE}/17-a11y-form.png`,
      fullPage: true,
    })
  })
})
