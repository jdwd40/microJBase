// Mutating admin schema endpoints (V02-18).
//
// Every internal typed mutation command — tables, columns, indexes,
// constraints, exposure, RLS, and ownership policies — is reachable only
// over HTTP with all of the following, enforced before the command reaches
// the internal service:
//
//  - operator-token authentication (admin-guard.ts);
//  - a unique Idempotency-Key header (D-017/D-025 replay contract);
//  - strict typed-body validation with unknown-field rejection; snake_case
//    JSON maps onto the frozen camelCase command shapes, never onto SQL;
//  - explicit confirmation values for destructive commands (D-015).
//
// Handlers never construct SQL and never see raw PostgreSQL errors: the
// audited compiler/executor maps every failure to a safe envelope (D-026).

import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
} from "fastify"

import type { ExecuteOutcome } from "../database/index.js"
import { AppError } from "../core/index.js"

import {
  type AdminDependencies,
  commandBase,
  DDL_COLUMN_TYPES,
  FOREIGN_KEY_ACTIONS,
  mapColumnSpec,
  type ColumnSpecInput,
  mapColumnDefault,
  mapOperationRecord,
  OWNERSHIP_POLICY_TEMPLATES,
  rejectUnknownFields,
  rejectUnlessAdminOperator,
  requireEnumField,
  requirePlainBody,
  requireStringArrayField,
  requireStringField,
} from "./admin-guard.js"
import { sendAppError, sendSuccess } from "./responses.js"

export async function registerAdminMutationRoutes(
  app: FastifyInstance,
  deps: AdminDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options

  registerTableMutations(app, deps)
  registerColumnMutations(app, deps)
  registerConstraintMutations(app, deps)
  registerExposureMutations(app, deps)
  registerRlsMutations(app, deps)
  registerPolicyMutations(app, deps)
}

function sendMutationOutcome(
  reply: FastifyReply,
  outcome: ExecuteOutcome,
): FastifyReply {
  return sendSuccess(reply, 200, {
    dry_run: outcome.dryRun,
    replayed: outcome.replayed,
    record: outcome.record === null ? null : mapOperationRecord(outcome.record),
  })
}

function requireObjectField(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = body[field]
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be an object",
    })
  }
  return value as Record<string, unknown>
}

function mapColumnSpecArray(value: unknown, field: string): ColumnSpecInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be an array of 1 to 64 column specs",
    })
  }
  return value.map((entry, index) => mapColumnSpec(entry, `${field}[${index}]`))
}

interface TablePathParams {
  schema: string
  table: string
}

function tableParams(request: { params: unknown }): TablePathParams {
  return request.params as TablePathParams
}

function registerTableMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.post("/v1/admin/schema/tables", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "tables.create",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["schema", "table", "columns", "dry_run"])
      const outcome = await deps.mutation.createTable({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
        columns: mapColumnSpecArray(body.columns, "columns"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(
    "/v1/admin/schema/tables/:schema/:table/rename",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "tables.rename",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["new_name", "dry_run"])
        const outcome = await deps.mutation.renameTable({
          ...commandBase(request, body),
          schema,
          table,
          newName: requireStringField(body, "new_name"),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(
    "/v1/admin/schema/tables/:schema/:table/drop",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "tables.drop",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["confirm", "dry_run"])
        const outcome = await deps.mutation.dropTable({
          ...commandBase(request, body),
          schema,
          table,
          confirm: requireStringField(body, "confirm"),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )
}

function registerColumnMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  const columnPath = "/v1/admin/schema/tables/:schema/:table/columns/:column"

  app.post(
    "/v1/admin/schema/tables/:schema/:table/columns",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "columns.add",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["column", "dry_run"])
        const outcome = await deps.mutation.addColumn({
          ...commandBase(request, body),
          schema,
          table,
          column: mapColumnSpec(body.column, "column"),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(`${columnPath}/rename`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.rename",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["new_name", "dry_run"])
      const outcome = await deps.mutation.renameColumn({
        ...commandBase(request, body),
        schema,
        table,
        column,
        newName: requireStringField(body, "new_name"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/drop`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.drop",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["confirm", "dry_run"])
      const outcome = await deps.mutation.dropColumn({
        ...commandBase(request, body),
        schema,
        table,
        column,
        confirm: requireStringField(body, "confirm"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/default`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.default.set",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["default", "dry_run"])
      const outcome = await deps.mutation.setColumnDefault({
        ...commandBase(request, body),
        schema,
        table,
        column,
        default: mapColumnDefault(body.default, "default"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/default/drop`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.default.drop",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["dry_run"])
      const outcome = await deps.mutation.dropColumnDefault({
        ...commandBase(request, body),
        schema,
        table,
        column,
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/not-null`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.not_null.set",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["dry_run"])
      const outcome = await deps.mutation.setColumnNotNull({
        ...commandBase(request, body),
        schema,
        table,
        column,
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/nullable`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.not_null.drop",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["dry_run"])
      const outcome = await deps.mutation.dropColumnNotNull({
        ...commandBase(request, body),
        schema,
        table,
        column,
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(`${columnPath}/type`, async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "columns.type.change",
      )
      if (rejected !== null) {
        return rejected
      }

      const { schema, table, column } = request.params as {
        schema: string
        table: string
        column: string
      }
      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["to_type", "dry_run"])
      const toType = requireEnumField(body, "to_type", DDL_COLUMN_TYPES)
      const outcome = await deps.mutation.changeColumnType({
        ...commandBase(request, body),
        schema,
        table,
        column,
        toType,
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}

function registerConstraintMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.post(
    "/v1/admin/schema/tables/:schema/:table/indexes",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "indexes.create",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["columns", "name", "dry_run"])
        const outcome = await deps.constraints.createIndex({
          ...commandBase(request, body),
          schema,
          table,
          columns: requireStringArrayField(body, "columns", {
            min: 1,
            max: 16,
          }),
          ...nameSpread(body),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(
    "/v1/admin/schema/tables/:schema/:table/indexes/:name/drop",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "indexes.drop",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table, name } = request.params as {
          schema: string
          table: string
          name: string
        }
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["dry_run"])
        const outcome = await deps.constraints.dropIndex({
          ...commandBase(request, body),
          schema,
          table,
          name,
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(
    "/v1/admin/schema/tables/:schema/:table/unique-constraints",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "unique_constraints.add",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["columns", "name", "dry_run"])
        const outcome = await deps.constraints.addUniqueConstraint({
          ...commandBase(request, body),
          schema,
          table,
          columns: requireStringArrayField(body, "columns", {
            min: 1,
            max: 16,
          }),
          ...nameSpread(body),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(
    "/v1/admin/schema/tables/:schema/:table/constraints/:name/drop",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "constraints.drop",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table, name } = request.params as {
          schema: string
          table: string
          name: string
        }
        const body = requirePlainBody(request)
        rejectUnknownFields(body, ["dry_run"])
        const outcome = await deps.constraints.dropConstraint({
          ...commandBase(request, body),
          schema,
          table,
          name,
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )

  app.post(
    "/v1/admin/schema/tables/:schema/:table/foreign-keys",
    async (request, reply) => {
      try {
        const rejected = rejectUnlessAdminOperator(
          request,
          reply,
          deps,
          "foreign_keys.add",
        )
        if (rejected !== null) {
          return rejected
        }

        const { schema, table } = tableParams(request)
        const body = requirePlainBody(request)
        rejectUnknownFields(body, [
          "columns",
          "references",
          "on_update",
          "on_delete",
          "name",
          "dry_run",
        ])
        const references = requireObjectField(body, "references")
        rejectUnknownFields(references, ["schema", "table", "columns"])
        const outcome = await deps.constraints.addForeignKey({
          ...commandBase(request, body),
          schema,
          table,
          columns: requireStringArrayField(body, "columns", {
            min: 1,
            max: 16,
          }),
          references: {
            schema: requireStringField(references, "schema"),
            table: requireStringField(references, "table"),
            columns: requireStringArrayField(references, "columns", {
              min: 1,
              max: 16,
            }),
          },
          onUpdate: requireEnumField(body, "on_update", FOREIGN_KEY_ACTIONS),
          onDelete: requireEnumField(body, "on_delete", FOREIGN_KEY_ACTIONS),
          ...nameSpread(body),
        })
        return sendMutationOutcome(reply, outcome)
      } catch (error: unknown) {
        return sendAppError(reply, error)
      }
    },
  )
}

function optionalName(body: Record<string, unknown>): string | undefined {
  const value = body.name
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      name: "Must be a non-empty string",
    })
  }
  return value
}

// exactOptionalPropertyTypes: omit the key entirely when no explicit name
// was supplied so the deterministic-name path stays untouched.
function nameSpread(body: Record<string, unknown>): { name: string } | object {
  const name = optionalName(body)
  return name === undefined ? {} : { name }
}

function registerExposureMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.post("/v1/admin/schema/exposure", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "exposure.expose",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["schema", "table", "alias", "dry_run"])
      const outcome = await deps.exposure.expose({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
        alias: requireStringField(body, "alias"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/admin/schema/unexpose", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "exposure.unexpose",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["schema", "table", "dry_run"])
      const outcome = await deps.exposure.unexpose({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}

function registerRlsMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.post("/v1/admin/schema/rls/enable", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "rls.enable",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["schema", "table", "dry_run"])
      const outcome = await deps.rls.enableRowSecurity({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/admin/schema/rls/disable", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "rls.disable",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, ["schema", "table", "confirm", "dry_run"])
      const outcome = await deps.rls.disableRowSecurity({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
        confirm: requireStringField(body, "confirm"),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}

function registerPolicyMutations(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  app.post("/v1/admin/schema/policies", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "policies.create",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, [
        "schema",
        "table",
        "column",
        "template",
        "dry_run",
      ])
      const outcome = await deps.policies.createOwnershipPolicy({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
        column: requireStringField(body, "column"),
        template: requireEnumField(
          body,
          "template",
          OWNERSHIP_POLICY_TEMPLATES,
        ),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/admin/schema/policies/remove", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "policies.remove",
      )
      if (rejected !== null) {
        return rejected
      }

      const body = requirePlainBody(request)
      rejectUnknownFields(body, [
        "schema",
        "table",
        "column",
        "template",
        "dry_run",
      ])
      const outcome = await deps.policies.removeOwnershipPolicy({
        ...commandBase(request, body),
        schema: requireStringField(body, "schema"),
        table: requireStringField(body, "table"),
        column: requireStringField(body, "column"),
        template: requireEnumField(
          body,
          "template",
          OWNERSHIP_POLICY_TEMPLATES,
        ),
      })
      return sendMutationOutcome(reply, outcome)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}
