// Minimal typed client for the frozen V02-17 read surface and the frozen
// V02-18 mutation surface.
//
// The paths below are the entire contract this client speaks — nothing else
// is called, and no path is constructed from anything other than the frozen
// templates plus URL-encoded operator-supplied identifiers. The envelope
// shape ({ data, error }) is the frozen one from CONTRACTS.md; errors are
// classified into the states the shell renders (auth, rate-limited, error).
// Mutations are always POSTed with a JSON body and an operator-supplied
// Idempotency-Key header; a dry run is the same POST with "dry_run": true.

export const ENDPOINTS = Object.freeze({
  capabilities: "/v1/admin/schema/capabilities",
  snapshot: "/v1/admin/schema",
  tableDetail: (schema, table) =>
    `/v1/admin/schema/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`,
  history: "/v1/admin/schema/history",
})

// The frozen V02-18 mutation paths (docs/admin-api.md). Identifiers are
// URL-encoded individually; no other path construction exists.
function tablePath(schema, table) {
  return `/v1/admin/schema/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`
}

export const MUTATIONS = Object.freeze({
  createTable: () => "/v1/admin/schema/tables",
  renameTable: (schema, table) => `${tablePath(schema, table)}/rename`,
  dropTable: (schema, table) => `${tablePath(schema, table)}/drop`,
  addColumn: (schema, table) => `${tablePath(schema, table)}/columns`,
  renameColumn: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/rename`,
  dropColumn: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/drop`,
  setColumnDefault: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/default`,
  dropColumnDefault: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/default/drop`,
  setColumnNotNull: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/not-null`,
  setColumnNullable: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/nullable`,
  changeColumnType: (schema, table, column) =>
    `${tablePath(schema, table)}/columns/${encodeURIComponent(column)}/type`,
  createIndex: (schema, table) => `${tablePath(schema, table)}/indexes`,
  dropIndex: (schema, table, name) =>
    `${tablePath(schema, table)}/indexes/${encodeURIComponent(name)}/drop`,
  addUniqueConstraint: (schema, table) =>
    `${tablePath(schema, table)}/unique-constraints`,
  dropConstraint: (schema, table, name) =>
    `${tablePath(schema, table)}/constraints/${encodeURIComponent(name)}/drop`,
  addForeignKey: (schema, table) => `${tablePath(schema, table)}/foreign-keys`,
  expose: () => "/v1/admin/schema/exposure",
  unexpose: () => "/v1/admin/schema/unexpose",
  enableRls: () => "/v1/admin/schema/rls/enable",
  disableRls: () => "/v1/admin/schema/rls/disable",
  createPolicy: () => "/v1/admin/schema/policies",
  removePolicy: () => "/v1/admin/schema/policies/remove",
})

const DEFAULT_TIMEOUT_MS = 15_000

function errorResult(status, code, message, retryAfter, details) {
  const result = {
    ok: false,
    status,
    code,
    message,
    retryAfter: null,
    details: null,
  }
  if (retryAfter !== null && retryAfter !== undefined) {
    result.retryAfter = retryAfter
  }
  if (details !== null && details !== undefined) {
    result.details = details
  }
  return result
}

function parseRetryAfter(headers) {
  const raw = headers.get("retry-after")
  if (raw === null) {
    return null
  }
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 0) {
    return null
  }
  return seconds
}

/**
 * One request against the admin surface.
 *
 * GET (default) or POST when options.body is present. Resolves to
 * { ok: true, data } on a 200 envelope, or
 * { ok: false, status, code, message, retryAfter } for every failure mode:
 *   - status 0  — network/timeout failure ("NETWORK_ERROR")
 *   - status 401 — AUTH_REQUIRED or INVALID_CREDENTIALS
 *   - status 429 — RATE_LIMITED, retryAfter from the Retry-After header
 *   - anything else — the frozen error code from the envelope when present.
 *
 * The token is read from the injected getter at call time, never stored here.
 */
export async function adminFetch(path, options) {
  const getToken = options.getToken
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const method = options.method ?? (options.body === undefined ? "GET" : "POST")
  const hasBody = options.body !== undefined

  const token = getToken()
  if (token === null) {
    return errorResult(0, "AUTH_REQUIRED", "Sign in with the operator token.")
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  }
  if (hasBody) {
    headers["content-type"] = "application/json"
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(path, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (cause) {
    const aborted = cause?.name === "AbortError"
    return errorResult(
      0,
      "NETWORK_ERROR",
      aborted
        ? "The server did not respond in time. Check the connection and retry."
        : "Could not reach the server. Check the connection and retry.",
      null,
    )
  } finally {
    clearTimeout(timer)
  }

  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (response.ok) {
    const data = body && typeof body === "object" ? body.data : undefined
    const meta =
      body && typeof body === "object" && "meta" in body ? body.meta : null
    return { ok: true, data, meta }
  }

  const envelopeError =
    body &&
    typeof body === "object" &&
    body.error &&
    typeof body.error === "object"
      ? body.error
      : null
  const code =
    typeof envelopeError?.code === "string"
      ? envelopeError.code
      : "INTERNAL_ERROR"
  const message =
    typeof envelopeError?.message === "string"
      ? envelopeError.message
      : "Request failed."
  const details =
    envelopeError !== null &&
    typeof envelopeError.details === "object" &&
    envelopeError.details !== null
      ? envelopeError.details
      : null
  return errorResult(
    response.status,
    code,
    message,
    parseRetryAfter(response.headers),
    details,
  )
}

/**
 * The frozen admin surface as typed calls over adminFetch. Read methods are
 * plain GETs; mutation methods POST a strict snake_case body with the
 * caller-supplied Idempotency-Key header and map camelCase inputs onto the
 * frozen HTTP fields. `input.dryRun === true` sends "dry_run": true;
 * otherwise the flag is omitted so the same idempotency key can graduate
 * from dry run to real execution.
 */
export function createAdminClient(options) {
  const mutate = (path, body, input) =>
    adminFetch(path, {
      ...options,
      method: "POST",
      body,
      idempotencyKey: input.idempotencyKey,
    })

  return {
    capabilities: () => adminFetch(ENDPOINTS.capabilities, options),
    snapshot: () => adminFetch(ENDPOINTS.snapshot, options),
    tableDetail: (schema, table) =>
      adminFetch(ENDPOINTS.tableDetail(schema, table), options),
    history: (limit, offset) =>
      adminFetch(
        `${ENDPOINTS.history}?limit=${limit}&offset=${offset}`,
        options,
      ),

    createTable: (input) =>
      mutate(
        MUTATIONS.createTable(),
        withDryRun(
          { schema: input.schema, table: input.table, columns: input.columns },
          input,
        ),
        input,
      ),
    renameTable: (input) =>
      mutate(
        MUTATIONS.renameTable(input.schema, input.table),
        withDryRun({ new_name: input.newName }, input),
        input,
      ),
    dropTable: (input) =>
      mutate(
        MUTATIONS.dropTable(input.schema, input.table),
        withDryRun({ confirm: input.confirm }, input),
        input,
      ),
    addColumn: (input) =>
      mutate(
        MUTATIONS.addColumn(input.schema, input.table),
        withDryRun({ column: input.column }, input),
        input,
      ),
    renameColumn: (input) =>
      mutate(
        MUTATIONS.renameColumn(input.schema, input.table, input.column),
        withDryRun({ new_name: input.newName }, input),
        input,
      ),
    dropColumn: (input) =>
      mutate(
        MUTATIONS.dropColumn(input.schema, input.table, input.column),
        withDryRun({ confirm: input.confirm }, input),
        input,
      ),
    setColumnDefault: (input) =>
      mutate(
        MUTATIONS.setColumnDefault(input.schema, input.table, input.column),
        withDryRun({ default: input.default }, input),
        input,
      ),
    dropColumnDefault: (input) =>
      mutate(
        MUTATIONS.dropColumnDefault(input.schema, input.table, input.column),
        withDryRun({}, input),
        input,
      ),
    setColumnNotNull: (input) =>
      mutate(
        MUTATIONS.setColumnNotNull(input.schema, input.table, input.column),
        withDryRun({}, input),
        input,
      ),
    setColumnNullable: (input) =>
      mutate(
        MUTATIONS.setColumnNullable(input.schema, input.table, input.column),
        withDryRun({}, input),
        input,
      ),
    changeColumnType: (input) =>
      mutate(
        MUTATIONS.changeColumnType(input.schema, input.table, input.column),
        withDryRun({ to_type: input.toType }, input),
        input,
      ),
    createIndex: (input) =>
      mutate(
        MUTATIONS.createIndex(input.schema, input.table),
        withDryRun({ columns: input.columns, ...optionalName(input) }, input),
        input,
      ),
    dropIndex: (input) =>
      mutate(
        MUTATIONS.dropIndex(input.schema, input.table, input.name),
        withDryRun({}, input),
        input,
      ),
    addUniqueConstraint: (input) =>
      mutate(
        MUTATIONS.addUniqueConstraint(input.schema, input.table),
        withDryRun({ columns: input.columns, ...optionalName(input) }, input),
        input,
      ),
    dropConstraint: (input) =>
      mutate(
        MUTATIONS.dropConstraint(input.schema, input.table, input.name),
        withDryRun({}, input),
        input,
      ),
    addForeignKey: (input) =>
      mutate(
        MUTATIONS.addForeignKey(input.schema, input.table),
        withDryRun(
          {
            columns: input.columns,
            references: input.references,
            on_update: input.onUpdate,
            on_delete: input.onDelete,
            ...optionalName(input),
          },
          input,
        ),
        input,
      ),
    expose: (input) =>
      mutate(
        MUTATIONS.expose(),
        withDryRun(
          { schema: input.schema, table: input.table, alias: input.alias },
          input,
        ),
        input,
      ),
    unexpose: (input) =>
      mutate(
        MUTATIONS.unexpose(),
        withDryRun({ schema: input.schema, table: input.table }, input),
        input,
      ),
    enableRls: (input) =>
      mutate(
        MUTATIONS.enableRls(),
        withDryRun({ schema: input.schema, table: input.table }, input),
        input,
      ),
    disableRls: (input) =>
      mutate(
        MUTATIONS.disableRls(),
        withDryRun(
          { schema: input.schema, table: input.table, confirm: input.confirm },
          input,
        ),
        input,
      ),
    createPolicy: (input) =>
      mutate(
        MUTATIONS.createPolicy(),
        withDryRun(
          {
            schema: input.schema,
            table: input.table,
            column: input.column,
            template: input.template,
          },
          input,
        ),
        input,
      ),
    removePolicy: (input) =>
      mutate(
        MUTATIONS.removePolicy(),
        withDryRun(
          {
            schema: input.schema,
            table: input.table,
            column: input.column,
            template: input.template,
          },
          input,
        ),
        input,
      ),
  }
}

function withDryRun(body, input) {
  return input !== undefined && input.dryRun === true
    ? { ...body, dry_run: true }
    : body
}

function optionalName(input) {
  return typeof input.name === "string" && input.name.trim() !== ""
    ? { name: input.name }
    : {}
}
