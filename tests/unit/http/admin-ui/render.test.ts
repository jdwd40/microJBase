// Unit coverage for the management UI render functions: exact markup,
// escaping of hostile catalogue data, and every state panel. Render
// functions are pure (view model -> HTML string), so the assertions run in
// Node without a DOM.

import { describe, expect, it } from "vitest"

// @ts-expect-error plain-JS browser module, untyped import boundary
import * as render from "../../../../admin-ui/render.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as viewModels from "../../../../admin-ui/view-models.js"

import { fixtureHistoryEnvelope, fixtureSnapshot } from "./fixtures.js"

describe("render.renderLogin", () => {
  it("renders a labelled password form without an error by default", () => {
    const html = render.renderLogin(null)
    expect(html).toContain('for="operator-token"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autocomplete="off"')
    expect(html).not.toContain("form-error")
  })

  it("announces errors with role=alert", () => {
    const html = render.renderLogin("The operator token was rejected.")
    expect(html).toContain('role="alert"')
    expect(html).toContain("The operator token was rejected.")
  })
})

describe("state panels", () => {
  it("renders a loading panel with a decorative spinner", () => {
    const html = render.renderLoading("Loading schemas", "Fetching…")
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("Fetching…")
  })

  it("renders empty, error (with retry), and rate-limited panels", () => {
    expect(render.renderEmpty("No schemas", "Nothing here.")).toContain(
      "Nothing here.",
    )
    const error = render.renderError("Something went wrong", "Boom")
    expect(error).toContain('role="alert"')
    expect(error).toContain('data-action="retry"')
    expect(render.renderRateLimited(42)).toContain("42 seconds")
    expect(render.renderRateLimited(null)).toContain("a short while")
  })

  it("marks the active navigation item", () => {
    expect(render.renderNav("schemas")).toContain(
      'data-nav="schemas" aria-current="page"',
    )
    expect(render.renderNav("history")).toContain(
      'data-nav="history" aria-current="page"',
    )
    expect(render.renderNav("schemas")).not.toContain(
      'data-nav="history" aria-current',
    )
  })
})

describe("render.renderSchemaList", () => {
  it("renders every schema with tables, badges, and column counts", () => {
    const html = render.renderSchemaList(
      viewModels.summarizeSnapshot(fixtureSnapshot),
    )
    expect(html).toContain('id="schema-app"')
    expect(html).toContain('id="schema-microjbase"')
    expect(html).toContain("No tables in this schema.")
    expect(html).toContain('data-action="open-table"')
    expect(html).toContain('data-schema="app"')
    expect(html).toContain('data-table="todos"')
    expect(html).toContain("Exposed as todos")
    expect(html).toContain("RLS forced")
    expect(html).toContain("badge-internal")
  })

  it("escapes hostile schema and table names", () => {
    const hostile = {
      schemas: [
        {
          name: 'evil"><script>',
          owner: "o",
          classification: "operator",
          tables: [
            {
              schema: 'evil"><script>',
              name: "<img onerror=x>",
              kind: "regular",
              classification: "operator",
              exposed: false,
              alias: null,
              rlsEnabled: false,
              rlsForced: false,
              columnCount: 1,
            },
          ],
        },
      ],
      migrations: [],
    }
    const html = render.renderSchemaList(hostile)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img onerror=x>")
    expect(html).toContain("&lt;img onerror=x&gt;")
  })

  it("renders the no-schemas empty state", () => {
    const html = render.renderSchemaList({ schemas: [], migrations: [] })
    expect(html).toContain("No schemas")
  })
})

describe("render.renderTableDetail", () => {
  const model = viewModels.tableDetailModel(
    fixtureSnapshot.schemas[0]!.tables[0]!,
  )

  it("renders summary, columns, constraints, and indexes sections", () => {
    const html = render.renderTableDetail(model)
    expect(html).toContain("app.todos")
    expect(html).toContain("Exposed as todos")
    expect(html).toContain("Enabled, forced")
    expect(html).toContain('id="table-columns-heading"')
    expect(html).toContain('id="table-constraints-heading"')
    expect(html).toContain('id="table-indexes-heading"')
    expect(html).toContain("todos_owner_fkey")
    expect(html).toContain("References app.users (id)")
    expect(html).toContain("CASCADE")
    expect(html).toContain("todos_expr_idx")
    expect(html).toContain("expression")
  })

  it("escapes hostile column names in every table", () => {
    const hostile = viewModels.tableDetailModel({
      ...fixtureSnapshot.schemas[0]!.tables[0]!,
      columns: [
        {
          ordinal: 1,
          name: "<script>alert(1)</script>",
          isNullable: true,
          defaultExpression: null,
          generated: "none",
          identity: "none",
          renderedType: "text",
        },
      ],
    })
    const html = render.renderTableDetail(hostile)
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("renders empty rows for tables without constraints or indexes", () => {
    const bare = viewModels.tableDetailModel(
      fixtureSnapshot.schemas[1]!.tables[0]!,
    )
    const html = render.renderTableDetail(bare)
    expect(html).toContain("No constraints reported on this table.")
    expect(html).toContain("No standalone indexes reported on this table.")
    expect(html).toContain("This table has no reported columns.")
  })
})

describe("render.renderHistory", () => {
  it("renders rows with UTC timestamps and error badges", () => {
    const view = viewModels.historyViewModel(fixtureHistoryEnvelope)
    const html = render.renderHistory(view)
    expect(html).toContain("2026-09-25 12:00:00 UTC")
    expect(html).toContain("schema.table.create")
    expect(html).toContain("schema.table.drop")
    expect(html).toContain("Succeeded")
    expect(html).toContain("Failed")
    expect(html).toContain("CONFLICT")
    expect(html).toContain("Showing 1&ndash;2")
  })

  it("renders the empty state with both pagination controls disabled", () => {
    const view = viewModels.historyViewModel({
      data: [],
      meta: { limit: 50, offset: 0 },
    })
    const html = render.renderHistory(view)
    expect(html).toContain("No operations recorded yet.")
    expect(html).toContain('data-action="history-prev" disabled')
    expect(html).toContain('data-action="history-next" disabled')
    expect(html).toContain("Showing 0&ndash;0")
  })

  it("keeps controls enabled when adjacent windows may exist", () => {
    const view = viewModels.historyViewModel({
      data: fixtureHistoryEnvelope.data,
      meta: { limit: 2, offset: 2 },
    })
    const html = render.renderHistory(view)
    expect(html).not.toContain('data-action="history-prev" disabled')
    expect(html).not.toContain('data-action="history-next" disabled')
  })
})
