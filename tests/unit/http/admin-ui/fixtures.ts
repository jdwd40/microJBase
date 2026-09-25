// Fixture data for the management UI unit suite.
//
// The shapes below mirror the frozen contracts exactly: the V02-03
// SchemaSnapshot document (camelCase, as carried inside the HTTP envelope's
// `data`) and the V02-17 snake_case history records. Values include hostile
// markup on purpose — render tests assert it never reaches the DOM string
// unescaped.

const uuidType = { schema: "pg_catalog", name: "uuid", kind: "base" }
const textType = { schema: "pg_catalog", name: "text", kind: "base" }

export const fixtureSnapshot = {
  schemas: [
    {
      name: "app",
      owner: "schema_admin",
      classification: "operator",
      tables: [
        {
          schema: "app",
          name: "todos",
          owner: "schema_admin",
          kind: "regular",
          hasRowSecurity: true,
          hasForcedRowSecurity: true,
          classification: "operator",
          exposure: { exposed: true, alias: "todos" },
          columns: [
            {
              ordinal: 1,
              name: "id",
              isNullable: false,
              defaultExpression: null,
              generated: "none",
              identity: "none",
              renderedType: "uuid",
              type: uuidType,
              baseType: null,
            },
            {
              ordinal: 2,
              name: "title<script>",
              isNullable: false,
              defaultExpression: "'untitled'::text",
              generated: "none",
              identity: "none",
              renderedType: "text",
              type: textType,
              baseType: null,
            },
          ],
          constraints: [
            {
              name: "todos_pkey",
              classification: "primary_key",
              columns: ["id"],
              references: null,
              onUpdate: null,
              onDelete: null,
            },
            {
              name: "todos_owner_fkey",
              classification: "foreign_key",
              columns: ["owner_id"],
              references: { schema: "app", table: "users", columns: ["id"] },
              onUpdate: "no_action",
              onDelete: "cascade",
            },
          ],
          indexes: [
            {
              name: "todos_title_idx",
              classification: "index",
              isUnique: false,
              isExpression: false,
              hasPredicate: false,
              columns: ["title"],
            },
            {
              name: "todos_expr_idx",
              classification: "expression_index",
              isUnique: true,
              isExpression: true,
              hasPredicate: true,
              columns: [null],
            },
          ],
        },
      ],
    },
    {
      name: "microjbase",
      owner: "postgres",
      classification: "internal",
      tables: [
        {
          schema: "microjbase",
          name: "sessions",
          owner: "postgres",
          kind: "regular",
          hasRowSecurity: false,
          hasForcedRowSecurity: false,
          classification: "internal",
          exposure: { exposed: false, alias: null },
          columns: [],
          constraints: [],
          indexes: [],
        },
      ],
    },
    {
      name: "empty_schema",
      owner: "postgres",
      classification: "operator",
      tables: [],
    },
  ],
  migrations: [
    {
      filename: "0001_init.sql",
      checksum: "abc123",
      appliedAt: "2026-09-25T12:00:00.000Z",
    },
  ],
}

export const fixtureHistoryEnvelope = {
  data: [
    {
      id: 7,
      idempotency_key: "2026-09-25-create-todos",
      command_type: "schema.table.create",
      command: { schema: "app", table: "todos", columns: [] },
      checksum: "deadbeef",
      status: "succeeded",
      actor_fingerprint: "salted-fingerprint",
      error_code: null,
      result: {},
      created_at: "2026-09-25T12:00:00.000Z",
      finished_at: "2026-09-25T12:00:00.100Z",
    },
    {
      id: 6,
      idempotency_key: "2026-09-25-drop-failed",
      command_type: "schema.table.drop",
      command: { schema: "app", table: "todos", confirm: "app.todos" },
      checksum: "cafe",
      status: "failed",
      actor_fingerprint: "salted-fingerprint",
      error_code: "CONFLICT",
      result: {},
      created_at: "2026-09-24T09:30:00.000Z",
      finished_at: null,
    },
  ],
  meta: { limit: 50, offset: 0 },
}
