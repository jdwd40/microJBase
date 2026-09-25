// Unit coverage for the management UI mutation layer (I2): the typed V02-18
// client (paths, headers, strict bodies, dry runs), the form specs in
// view-models (frozen allowlists, validation, confirmation values), and the
// mutation renderers (exact markup, escaping, availability rules).

import { describe, expect, it } from "vitest"

// @ts-expect-error plain-JS browser module, untyped import boundary
import * as api from "../../../../admin-ui/api.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as render from "../../../../admin-ui/render.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as viewModels from "../../../../admin-ui/view-models.js"

import { fixtureSnapshot } from "./fixtures.js"

function jsonResponse(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

const CTX = { schema: "app", table: "todos" }
const CTX_COLUMN = { schema: "app", table: "todos", column: "title" }

describe("frozen mutation endpoint set", () => {
  it("builds every V02-18 path with URL-encoded identifiers", () => {
    expect(api.MUTATIONS.createTable()).toBe("/v1/admin/schema/tables")
    expect(api.MUTATIONS.renameTable("my schema", "weird/table")).toBe(
      "/v1/admin/schema/tables/my%20schema/weird%2Ftable/rename",
    )
    expect(api.MUTATIONS.dropColumn("app", "todos", "a/b")).toBe(
      "/v1/admin/schema/tables/app/todos/columns/a%2Fb/drop",
    )
    expect(api.MUTATIONS.changeColumnType("app", "todos", "title")).toBe(
      "/v1/admin/schema/tables/app/todos/columns/title/type",
    )
    expect(api.MUTATIONS.dropIndex("app", "todos", "i/x")).toBe(
      "/v1/admin/schema/tables/app/todos/indexes/i%2Fx/drop",
    )
    expect(api.MUTATIONS.dropConstraint("app", "todos", "c")).toBe(
      "/v1/admin/schema/tables/app/todos/constraints/c/drop",
    )
    expect(api.MUTATIONS.addForeignKey("app", "todos")).toBe(
      "/v1/admin/schema/tables/app/todos/foreign-keys",
    )
    expect(api.MUTATIONS.expose()).toBe("/v1/admin/schema/exposure")
    expect(api.MUTATIONS.unexpose()).toBe("/v1/admin/schema/unexpose")
    expect(api.MUTATIONS.enableRls()).toBe("/v1/admin/schema/rls/enable")
    expect(api.MUTATIONS.disableRls()).toBe("/v1/admin/schema/rls/disable")
    expect(api.MUTATIONS.createPolicy()).toBe("/v1/admin/schema/policies")
    expect(api.MUTATIONS.removePolicy()).toBe(
      "/v1/admin/schema/policies/remove",
    )
  })
})

describe("api mutation client", () => {
  it("POSTs a strict body with the idempotency key and no dry_run flag", async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const client = api.createAdminClient({
      getToken: () => "op-token",
      fetchImpl: async (url: string, init: RequestInit) => {
        seen = { url, init }
        return jsonResponse(200, {
          data: { dry_run: false, replayed: false, record: null },
        })
      },
    })
    const result = await client.renameTable({
      schema: "app",
      table: "todos",
      newName: "tasks",
      idempotencyKey: "ui-key-1",
    })
    expect(result.ok).toBe(true)
    expect(seen).not.toBeNull()
    expect(seen!.url).toBe("/v1/admin/schema/tables/app/todos/rename")
    expect(seen!.init.method).toBe("POST")
    expect(seen!.init.headers).toMatchObject({
      authorization: "Bearer op-token",
      "content-type": "application/json",
      "idempotency-key": "ui-key-1",
    })
    expect(JSON.parse(String(seen!.init.body))).toEqual({ new_name: "tasks" })
  })

  it("sends dry_run only when requested and omits empty optional names", async () => {
    const bodies: unknown[] = []
    const client = api.createAdminClient({
      getToken: () => "op-token",
      fetchImpl: async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return jsonResponse(200, {
          data: { dry_run: true, replayed: false, record: null },
        })
      },
    })
    await client.createIndex({
      schema: "app",
      table: "todos",
      columns: ["title"],
      idempotencyKey: "ui-key-2",
      dryRun: true,
    })
    await client.createIndex({
      schema: "app",
      table: "todos",
      columns: ["title"],
      name: "todos_title_idx",
      idempotencyKey: "ui-key-3",
    })
    expect(bodies[0]).toEqual({ columns: ["title"], dry_run: true })
    expect(bodies[1]).toEqual({
      columns: ["title"],
      name: "todos_title_idx",
    })
  })

  it("maps foreign keys, policies, exposure, and RLS onto the frozen bodies", async () => {
    const bodies: unknown[] = []
    const client = api.createAdminClient({
      getToken: () => "op-token",
      fetchImpl: async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return jsonResponse(200, {
          data: { dry_run: false, replayed: false, record: null },
        })
      },
    })
    await client.addForeignKey({
      schema: "app",
      table: "todos",
      columns: ["owner_id"],
      references: { schema: "app", table: "users", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
      idempotencyKey: "k",
    })
    await client.disableRls({
      schema: "app",
      table: "todos",
      confirm: "app.todos",
      idempotencyKey: "k",
    })
    await client.createPolicy({
      schema: "app",
      table: "todos",
      column: "owner_id",
      template: "read",
      idempotencyKey: "k",
    })
    await client.expose({
      schema: "app",
      table: "todos",
      alias: "tasks",
      idempotencyKey: "k",
    })
    expect(bodies).toEqual([
      {
        columns: ["owner_id"],
        references: { schema: "app", table: "users", columns: ["id"] },
        on_update: "no_action",
        on_delete: "cascade",
      },
      { schema: "app", table: "todos", confirm: "app.todos" },
      { schema: "app", table: "todos", column: "owner_id", template: "read" },
      { schema: "app", table: "todos", alias: "tasks" },
    ])
  })

  it("captures field-level details from the frozen error envelope", async () => {
    const client = api.createAdminClient({
      getToken: () => "op-token",
      fetchImpl: async () =>
        jsonResponse(400, {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: { alias: "Must be a non-empty string" },
          },
        }),
    })
    const result = await client.expose({
      schema: "app",
      table: "todos",
      alias: "",
      idempotencyKey: "k",
    })
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      details: { alias: "Must be a non-empty string" },
    })
  })
})

describe("view-model mutation specs", () => {
  it("issues idempotency keys in the frozen header format", () => {
    const key = viewModels.newIdempotencyKey()
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
    expect(key.startsWith("ui-")).toBe(true)
    expect(viewModels.newIdempotencyKey()).not.toBe(key)
  })

  it("parses literal defaults into JSON primitives", () => {
    expect(viewModels.parseLiteralDefault('"untitled"')).toBe("untitled")
    expect(viewModels.parseLiteralDefault("42")).toBe(42)
    expect(viewModels.parseLiteralDefault("true")).toBe(true)
    expect(viewModels.parseLiteralDefault("null")).toBeNull()
    expect(viewModels.parseLiteralDefault("plain text")).toBe("plain text")
    expect(viewModels.parseLiteralDefault("[1,2]")).toBe("[1,2]")
  })

  it("refuses unknown specs", () => {
    expect(() => viewModels.mutationSpec("nope")).toThrow()
  })

  it("requires the exact confirmation value on destructive forms", () => {
    const spec = viewModels.mutationSpec("table.drop")
    expect(spec.confirmValue(CTX)).toBe("app.todos")
    const columnSpec = viewModels.mutationSpec("column.drop")
    expect(columnSpec.confirmValue(CTX_COLUMN)).toBe("app.todos.title")
    const rlsSpec = viewModels.mutationSpec("rls.disable")
    expect(rlsSpec.confirmValue(CTX)).toBe("app.todos")
  })

  it("builds create-table bodies with the frozen template model", () => {
    const spec = viewModels.mutationSpec("table.create")
    const values = {
      schema: "app",
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: false,
          default_kind: "literal",
          default_value: '"untitled"',
        },
        {
          name: "owner_id",
          type: "uuid",
          nullable: true,
          default_kind: "none",
          default_value: "",
        },
      ],
    }
    const errors: string[] = []
    spec.validate(values, errors)
    expect(errors).toEqual([])
    expect(spec.buildInput(values)).toEqual({
      schema: "app",
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: false,
          default: { kind: "literal", value: "untitled" },
        },
        {
          name: "owner_id",
          type: "uuid",
          nullable: true,
          default: { kind: "none" },
        },
      ],
    })
  })

  it("rejects invalid identifiers, the managed id name, and wrong default/type pairs", () => {
    const spec = viewModels.mutationSpec("column.add")
    const cases = [
      { name: "id", type: "text", nullable: true, default_kind: "none" },
      { name: "1bad", type: "text", nullable: true, default_kind: "none" },
      { name: "ok", type: "text", nullable: true, default_kind: "random_uuid" },
      {
        name: "ok",
        type: "integer",
        nullable: true,
        default_kind: "current_timestamp",
      },
    ]
    for (const values of cases) {
      const errors: string[] = []
      spec.validate(values, errors)
      expect(errors.length).toBeGreaterThan(0)
    }
  })

  it("enforces SET NULL only on nullable referencing columns", () => {
    const cleanModel = viewModels.tableDetailModel({
      ...fixtureSnapshot.schemas[0]!.tables[0]!,
      columns: [
        {
          ordinal: 1,
          name: "title",
          isNullable: false,
          defaultExpression: null,
          generated: "none",
          identity: "none",
          renderedType: "text",
        },
      ],
    })
    const spec = viewModels.mutationSpec("fk.add")
    const errors: string[] = []
    spec.validate(
      {
        columns: ["title"],
        ref_schema: "app",
        ref_table: "users",
        ref_columns: "id",
        on_update: "set_null",
        on_delete: "no_action",
      },
      errors,
      { ...CTX, model: cleanModel },
    )
    expect(errors.join(" ")).toContain("SET NULL")
  })

  it("maps every spec onto a client method and stable summaries", () => {
    const specs = viewModels.MUTATION_SPECS as Record<
      string,
      { id: string; method: string; summarize: unknown; buildInput: unknown }
    >
    for (const [id, spec] of Object.entries(specs)) {
      expect(spec.id).toBe(id)
      expect(typeof api.MUTATIONS).toBe("object")
      expect(spec.method).toMatch(/^[a-zA-Z]+$/)
      expect(typeof spec.summarize).toBe("function")
      expect(typeof spec.buildInput).toBe("function")
    }
  })
})

describe("render mutation UI", () => {
  const model = viewModels.tableDetailModel(
    fixtureSnapshot.schemas[0]!.tables[0]!,
  )
  const unexposed = { ...model, exposed: false }

  it("renders action groups for operator tables and nothing for internal ones", () => {
    const actions = render.renderTableActions(unexposed)
    expect(actions).toContain("Rename table")
    expect(actions).toContain("Drop table")
    expect(actions).toContain("Add column")
    expect(actions).toContain("Disable row security")
    expect(actions).toContain("Expose table")
    expect(actions).toContain("Create index")
    expect(actions).toContain("data-dangerous")
    const internal = render.renderTableActions({
      ...model,
      classification: "internal",
    })
    expect(internal).toBe("")
  })

  it("limits exposed tables to unexpose plus index and constraint work", () => {
    const exposed = render.renderTableActions({ ...model, exposed: true })
    expect(exposed).toContain("Unexpose table")
    expect(exposed).not.toContain("Rename table")
    expect(exposed).not.toContain("Drop table")
    expect(exposed).not.toContain("Add column")
    expect(exposed).toContain("This table is exposed")
  })

  it("skips actions for the managed id column and unmanageable constraints", () => {
    expect(render.renderColumnActions(unexposed, model.columns[0]!)).toBe("")
    expect(render.renderColumnActions(model, model.columns[1]!)).toBe("")
    const title = model.columns[1]!
    const actions = render.renderColumnActions(unexposed, title)
    expect(actions).toContain("Rename")
    expect(actions).toContain("Drop")
    expect(actions).toContain("Change type")
    expect(actions).toContain('data-column="title&lt;script&gt;"')
    const pk = { name: "todos_pkey", classification: "primary_key" }
    expect(render.renderConstraintActions(model, pk)).toBe("")
    const unique = { name: "todos_title_key", classification: "unique" }
    expect(render.renderConstraintActions(model, unique)).toContain("Drop")
  })

  it("renders a labelled form with a readonly key, disabled apply, and confirm hint", () => {
    const spec = viewModels.mutationSpec("table.drop")
    const html = render.renderMutationForm(spec, CTX, {}, "ui-key-9")
    expect(html).toContain('data-spec="table.drop"')
    expect(html).toContain('for="mf-confirm"')
    expect(html).toContain("<code>app.todos</code>")
    expect(html).toContain('value="ui-key-9"')
    expect(html).toContain("readonly")
    expect(html).toContain('data-mode="apply" disabled')
    expect(html).toContain('data-mode="dry-run"')
    expect(html).toContain('data-action="mutation-cancel"')
    expect(html).toContain('aria-live="polite"')
  })

  it("renders the create-table editor with one row and add/remove controls", () => {
    const spec = viewModels.mutationSpec("table.create")
    const values = spec.initialValues()
    values.schema = "app"
    values.table = "notes"
    const html = render.renderMutationForm(spec, { schema: "app" }, values, "k")
    expect(html).toContain('name="schema"')
    expect(html).toContain('name="table"')
    expect(html.match(/data-column-row/g)).toHaveLength(1)
    expect(html).toContain('data-action="column-row-add"')
    expect(html).toContain('data-action="column-row-remove"')
    expect(html).toContain('hidden data-col-field="default_value"')
  })

  it("renders column pickers from the table model", () => {
    const spec = viewModels.mutationSpec("index.create")
    const values = { columns: ["id"], name: "" }
    const html = render.renderMutationForm(spec, { ...CTX, model }, values, "k")
    expect(html).toContain('name="columns"')
    expect(html).toContain('value="id" checked')
    expect(html).toContain("title&lt;script&gt;")
  })

  it("escapes hostile values in forms, buttons, and banners", () => {
    const hostile = viewModels.mutationSpec("table.rename")
    const html = render.renderMutationForm(
      hostile,
      { schema: 'a"><', table: "t" },
      { new_name: 'x"><script>' },
      'key"><',
    )
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")

    const banner = render.renderMutationPreview('create"><', 'k"><')
    expect(banner).not.toContain('create"><')
    expect(banner).toContain("&quot;&gt;&lt;")

    const failure = render.renderMutationFailure("CONFLICT", 'boom"><', {
      field: 'd"><',
    })
    expect(failure).not.toContain('d"><')
  })

  it("renders the recorded outcome with statement counts and replay notes", () => {
    const record = {
      id: 7,
      idempotency_key: "k",
      command_type: "schema.table.create",
      status: "succeeded",
      result: { statement_count: 2 },
    }
    const html = render.renderMutationResult(record, false)
    expect(html).toContain("Change applied.")
    expect(html).toContain("schema.table.create")
    expect(html).toContain("2 statement(s) executed.")
    expect(render.renderMutationResult(record, true)).toContain(
      "replayed without re-executing",
    )
  })
})
