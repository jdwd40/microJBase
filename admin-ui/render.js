// Pure render functions for the management UI: view models in, HTML strings
// out. No DOM access — app.js owns the browser wiring — so the unit suite can
// assert the exact markup from Node. Every interpolated value passes through
// escapeHtml because catalogue data (schema/table/column names) is untrusted.

import {
  escapeHtml,
  formatColumnList,
  formatUtcDateTime,
  humanize,
} from "./format.js"
import { safeChangeTargets } from "./view-models.js"

export function renderLogin(errorMessage) {
  const error = errorMessage
    ? `<p class="form-error" role="alert">${escapeHtml(errorMessage)}</p>`
    : ""
  return `
    ${error}
    <form id="login-form">
      <div class="field">
        <label for="operator-token">Operator token</label>
        <input
          id="operator-token"
          name="operator-token"
          type="password"
          autocomplete="off"
          required
        />
      </div>
      <button type="submit" class="button">Sign in</button>
    </form>
  `
}

export function renderNav(active) {
  const schemasCurrent = active === "schemas" ? ' aria-current="page"' : ""
  const historyCurrent = active === "history" ? ' aria-current="page"' : ""
  return `
    <ul>
      <li><a href="#schemas" data-nav="schemas"${schemasCurrent}>Schemas</a></li>
      <li><a href="#history" data-nav="history"${historyCurrent}>History</a></li>
    </ul>
  `
}

export function renderLoading(heading, message) {
  return `
    <section class="panel state-panel" aria-label="${escapeHtml(heading)}">
      <span class="spinner" aria-hidden="true"></span>
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(message)}</p>
    </section>
  `
}

export function renderEmpty(heading, message) {
  return `
    <section class="panel state-panel">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(message)}</p>
    </section>
  `
}

export function renderError(heading, message) {
  return `
    <section class="panel state-panel" role="alert">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(message)}</p>
      <button type="button" class="button" data-action="retry">Retry</button>
    </section>
  `
}

export function renderRateLimited(retryAfter) {
  const wait = retryAfter === null ? "a short while" : `${retryAfter} seconds`
  return `
    <section class="panel state-panel rate-panel" role="alert">
      <h2>Rate limit exceeded</h2>
      <p>
        The server is limiting admin requests. Retrying automatically in
        <strong data-retry-after>${escapeHtml(wait)}</strong>.
      </p>
    </section>
  `
}

function classificationBadge(classification) {
  if (classification === "internal") {
    return '<span class="badge badge-internal">Internal</span>'
  }
  return ""
}

function exposureBadges(table) {
  if (table.exposed) {
    const alias = table.alias === null ? "" : ` as ${escapeHtml(table.alias)}`
    return `<span class="badge badge-exposed">Exposed${alias}</span>`
  }
  return '<span class="badge badge-muted">Not exposed</span>'
}

function rlsBadges(table) {
  if (table.rlsEnabled && table.rlsForced) {
    return '<span class="badge">RLS forced</span>'
  }
  if (table.rlsEnabled) {
    return '<span class="badge">RLS</span>'
  }
  return '<span class="badge badge-muted">RLS off</span>'
}

export function renderSchemaList(summary) {
  if (summary.schemas.length === 0) {
    return renderEmpty(
      "No schemas",
      "The snapshot reports no non-system schemas on this database.",
    )
  }
  const sections = summary.schemas.map((schema) => {
    const rows =
      schema.tables.length === 0
        ? `<tr><td colspan="4">No tables in this schema.</td></tr>`
        : schema.tables
            .map((table) => {
              return `
                <tr>
                  <td>
                    <button
                      type="button"
                      class="row-button"
                      data-action="open-table"
                      data-schema="${escapeHtml(table.schema)}"
                      data-table="${escapeHtml(table.name)}"
                    >${escapeHtml(`${table.schema}.${table.name}`)}</button>
                  </td>
                  <td>${escapeHtml(humanize(table.kind))}</td>
                  <td>
                    ${classificationBadge(table.classification)}
                    ${exposureBadges(table)}
                    ${rlsBadges(table)}
                  </td>
                  <td>${table.columnCount}</td>
                </tr>
              `
            })
            .join("")
    return `
      <section class="panel" aria-labelledby="schema-${escapeHtml(schema.name)}">
        <div class="panel-heading-row">
          <h2 id="schema-${escapeHtml(schema.name)}">
            ${escapeHtml(schema.name)}
            ${classificationBadge(schema.classification)}
          </h2>
          ${schema.classification === "operator" ? renderCreateTableButton(schema.name) : ""}
        </div>
        <table class="table-list">
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col">Columns</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `
  })
  return sections.join("")
}

function definitionTerm(label) {
  return `<dt>${escapeHtml(label)}</dt>`
}

function definitionDescription(value) {
  return `<dd>${escapeHtml(value)}</dd>`
}

export function renderTableDetail(table) {
  const showColumnActions =
    table.classification === "operator" && !table.exposed
  const columnRows =
    table.columns.length === 0
      ? `<tr><td colspan="${showColumnActions ? 6 : 5}">This table has no reported columns.</td></tr>`
      : table.columns
          .map((column) => {
            return `
              <tr>
                <td>${escapeHtml(column.name)}</td>
                <td>${escapeHtml(column.renderedType)}</td>
                <td>${column.nullable ? "Nullable" : "Not null"}</td>
                <td>${
                  column.defaultExpression === null
                    ? "—"
                    : escapeHtml(column.defaultExpression)
                }</td>
                <td>
                  ${column.generated === "none" ? "" : `<span class="badge">Generated (${escapeHtml(humanize(column.generated))})</span>`}
                  ${column.identity === "none" ? "" : `<span class="badge">Identity (${escapeHtml(humanize(column.identity))})</span>`}
                  ${column.generated === "none" && column.identity === "none" ? '<span class="badge badge-muted">—</span>' : ""}
                </td>
                <td>${showColumnActions ? renderColumnActions(table, column) : ""}</td>
              </tr>
            `
          })
          .join("")

  const constraintRows =
    table.constraints.length === 0
      ? '<tr><td colspan="4">No constraints reported on this table.</td></tr>'
      : table.constraints
          .map((constraint) => {
            const reference =
              constraint.references === null
                ? ""
                : `<span class="badge">References ${escapeHtml(
                    `${constraint.references.schema}.${constraint.references.table} (${formatColumnList(constraint.references.columns)})`,
                  )} · ${escapeHtml(humanize(constraint.onUpdate))} / ${escapeHtml(humanize(constraint.onDelete))}</span>`
            return `
              <tr>
                <td>${escapeHtml(constraint.name)}</td>
                <td>${escapeHtml(humanize(constraint.classification))}</td>
                <td>${escapeHtml(formatColumnList(constraint.columns))} ${reference}</td>
                <td>${renderConstraintActions(table, constraint)}</td>
              </tr>
            `
          })
          .join("")

  const indexRows =
    table.indexes.length === 0
      ? '<tr><td colspan="5">No standalone indexes reported on this table.</td></tr>'
      : table.indexes
          .map((index) => {
            const flags = [
              index.isUnique ? "Unique" : null,
              index.isExpression ? "Expression" : null,
              index.hasPredicate ? "Partial" : null,
            ]
              .filter(Boolean)
              .join(", ")
            return `
              <tr>
                <td>${escapeHtml(index.name)}</td>
                <td>${escapeHtml(formatColumnList(index.columns))}</td>
                <td>${escapeHtml(flags === "" ? "—" : flags)}</td>
                <td>${escapeHtml(humanize(index.classification))}</td>
                <td>${renderIndexActions(table, index)}</td>
              </tr>
            `
          })
          .join("")

  return `
    <a href="#schemas" class="back-link" data-action="back-to-schemas">&larr; Back to schemas</a>
    ${renderTableActions(table)}
    <section class="panel" aria-labelledby="table-summary-heading">
      <h2 id="table-summary-heading">${escapeHtml(table.fullName)}</h2>
      <dl class="summary-list">
        ${definitionTerm("Owner")}${definitionDescription(table.owner)}
        ${definitionTerm("Kind")}${definitionDescription(humanize(table.kind))}
        ${definitionTerm("Classification")}${definitionDescription(humanize(table.classification))}
        ${definitionTerm("Exposure")}${definitionDescription(table.exposed ? `Exposed as ${table.alias ?? "?"}` : "Not exposed")}
        ${definitionTerm("Row security")}${definitionDescription(table.rlsEnabled ? (table.rlsForced ? "Enabled, forced" : "Enabled") : "Disabled")}
        ${definitionTerm("Columns")}${definitionDescription(String(table.columns.length))}
      </dl>
    </section>
    <section class="panel" aria-labelledby="table-columns-heading">
      <h2 id="table-columns-heading">Columns</h2>
      <table class="table-list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Nullability</th>
            <th scope="col">Default</th>
            <th scope="col">Generated / identity</th>
            ${showColumnActions ? '<th scope="col">Actions</th>' : ""}
          </tr>
        </thead>
        <tbody>${columnRows}</tbody>
      </table>
    </section>
    <section class="panel" aria-labelledby="table-constraints-heading">
      <h2 id="table-constraints-heading">Constraints</h2>
      <table class="table-list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Columns / reference</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>${constraintRows}</tbody>
      </table>
    </section>
    <section class="panel" aria-labelledby="table-indexes-heading">
      <h2 id="table-indexes-heading">Indexes</h2>
      <table class="table-list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Columns</th>
            <th scope="col">Flags</th>
            <th scope="col">Classification</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>${indexRows}</tbody>
      </table>
    </section>
  `
}

export function renderHistory(view) {
  const rows =
    view.rows.length === 0
      ? '<tr><td colspan="5">No operations recorded yet.</td></tr>'
      : view.rows
          .map((row) => {
            const error =
              row.errorCode === null
                ? ""
                : `<span class="badge badge-internal">${escapeHtml(row.errorCode)}</span>`
            return `
              <tr>
                <td>${escapeHtml(formatUtcDateTime(row.createdAt))}</td>
                <td>${escapeHtml(row.commandType)}</td>
                <td>${escapeHtml(row.idempotencyKey)}</td>
                <td>${escapeHtml(humanize(row.status))} ${error}</td>
                <td>${escapeHtml(row.finishedAt === null ? "—" : formatUtcDateTime(row.finishedAt))}</td>
              </tr>
            `
          })
          .join("")
  const from = view.rows.length === 0 ? 0 : view.offset + 1
  const to = view.rows.length === 0 ? 0 : view.offset + view.rows.length
  return `
    <section class="panel" aria-labelledby="history-panel-heading">
      <h2 id="history-panel-heading">Operation history</h2>
      <table class="table-list">
        <thead>
          <tr>
            <th scope="col">Created</th>
            <th scope="col">Command</th>
            <th scope="col">Idempotency key</th>
            <th scope="col">Status</th>
            <th scope="col">Finished</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pagination">
        <button type="button" class="button button-secondary" data-action="history-prev"${view.hasPrevious ? "" : " disabled"}>Previous</button>
        <span>Showing ${from}&ndash;${to}</span>
        <button type="button" class="button button-secondary" data-action="history-next"${view.hasNext ? "" : " disabled"}>Next</button>
      </div>
    </section>
  `
}

// ---------------------------------------------------------------------------
// Mutation UI (I2): action buttons on the overview and table detail, and the
// generic typed form renderer driven by the specs in view-models.js.
// ---------------------------------------------------------------------------

function mutationButton(spec, label, ctx, extraAttrs = "") {
  const parts = [
    `data-action="mutation-open"`,
    `data-spec="${escapeHtml(spec)}"`,
    `data-schema="${escapeHtml(ctx.schema)}"`,
  ]
  if (ctx.table !== undefined) {
    parts.push(`data-table="${escapeHtml(ctx.table)}"`)
  }
  if (ctx.column !== undefined) {
    parts.push(`data-column="${escapeHtml(ctx.column)}"`)
  }
  if (ctx.name !== undefined) {
    parts.push(`data-name="${escapeHtml(ctx.name)}"`)
  }
  return `<button type="button" class="button button-secondary" ${parts.join(" ")}${extraAttrs}>${escapeHtml(label)}</button>`
}

/**
 * The Actions panel for a table detail page. Internal tables get nothing;
 * exposed tables get only the exposure and index/constraint workflows the
 * frozen executor allows, with a note explaining the rest.
 */
export function renderTableActions(model) {
  if (model.classification !== "operator") {
    return ""
  }
  const base = { schema: model.schema, table: model.name }
  const groups = []
  if (model.exposed) {
    groups.push(
      `<div class="action-group"><p class="action-group-title">Exposure</p>${mutationButton("exposure.unexpose", "Unexpose table", base)}</div>`,
    )
  } else {
    const tableButtons = [
      mutationButton("table.rename", "Rename table", base),
      mutationButton(
        "table.drop",
        "Drop table",
        base,
        ' data-dangerous="true"',
      ),
    ].join("")
    const rlsButtons = model.rlsEnabled
      ? [
          mutationButton(
            "rls.disable",
            "Disable row security",
            base,
            ' data-dangerous="true"',
          ),
          mutationButton("policy.create", "Add ownership policy", base),
          mutationButton("policy.remove", "Remove ownership policy", base),
        ].join("")
      : [
          mutationButton("rls.enable", "Enable row security", base),
          mutationButton("policy.create", "Add ownership policy", base),
          mutationButton("policy.remove", "Remove ownership policy", base),
        ].join("")
    groups.push(
      `<div class="action-group"><p class="action-group-title">Table</p>${tableButtons}</div>`,
      `<div class="action-group"><p class="action-group-title">Columns</p>${mutationButton("column.add", "Add column", base)}</div>`,
      `<div class="action-group"><p class="action-group-title">Row security</p>${rlsButtons}</div>`,
      `<div class="action-group"><p class="action-group-title">Exposure</p>${mutationButton("exposure.expose", "Expose table", base)}</div>`,
    )
  }
  const constraintButtons = [
    mutationButton("index.create", "Create index", base),
    mutationButton("unique.add", "Add unique constraint", base),
    mutationButton("fk.add", "Add foreign key", base),
  ].join("")
  groups.push(
    `<div class="action-group"><p class="action-group-title">Indexes and constraints</p>${constraintButtons}</div>`,
  )

  const note = model.exposed
    ? `<p class="action-note">This table is exposed to the data API, so structural changes, row-security changes, and policy changes are unavailable. Unexpose it first; indexes and constraints stay manageable.</p>`
    : ""
  return `
    <section class="panel" aria-labelledby="table-actions-heading">
      <h2 id="table-actions-heading">Actions</h2>
      <div class="action-groups">${groups.join("")}</div>
      ${note}
    </section>
  `
}

/**
 * Per-column action buttons. The managed id column is lifecycle-owned, so it
 * gets none; exposed tables render no actions column at all (callers check).
 * Every label names its column so the accessible name disambiguates the
 * identical buttons across one table. Change type appears only when the
 * frozen safe-conversion matrix has a target for the column's catalogue
 * rendering.
 */
export function renderColumnActions(model, column) {
  if (model.classification !== "operator" || model.exposed) {
    return ""
  }
  if (column.name === "id") {
    return ""
  }
  const ctx = { schema: model.schema, table: model.name, column: column.name }
  const buttons = [
    ["column.rename", `Rename ${column.name}`],
    ["column.drop", `Drop ${column.name}`, ' data-dangerous="true"'],
    ["column.default.set", `Set default on ${column.name}`],
    ["column.default.drop", `Drop default on ${column.name}`],
    ["column.not_null.set", `Set not null on ${column.name}`],
    ["column.nullable", `Allow null on ${column.name}`],
  ]
  if (safeChangeTargets(model, column.name).length > 0) {
    buttons.push(["column.type.change", `Change type of ${column.name}`])
  }
  return `<div class="row-actions">${buttons
    .map(([spec, label, extra]) =>
      mutationButton(spec, label, ctx, extra ?? ""),
    )
    .join("")}</div>`
}

/** Per-index drop button (standalone indexes only). */
export function renderIndexActions(model, index) {
  if (model.classification !== "operator") {
    return ""
  }
  return mutationButton("index.drop", `Drop ${index.name}`, {
    schema: model.schema,
    table: model.name,
    name: index.name,
  })
}

/**
 * Per-constraint drop button for manageable classifications only; primary
 * keys, check, and exclusion constraints refuse server-side and get no
 * button.
 */
export function renderConstraintActions(model, constraint) {
  if (model.classification !== "operator") {
    return ""
  }
  if (
    constraint.classification !== "unique" &&
    constraint.classification !== "foreign_key"
  ) {
    return ""
  }
  return mutationButton("constraint.drop", `Drop ${constraint.name}`, {
    schema: model.schema,
    table: model.name,
    name: constraint.name,
  })
}

/** The "Create table" button rendered on each operator schema overview card. */
export function renderCreateTableButton(schemaName) {
  return `<button type="button" class="button button-secondary" data-action="mutation-open" data-spec="table.create" data-schema="${escapeHtml(schemaName)}">Create table</button>`
}

// --- typed mutation form rendering -----------------------------------------

let fieldCounter = 0

function fieldId() {
  fieldCounter += 1
  return `mf-${fieldCounter}`
}

function renderField(field, values, ctx) {
  const id = fieldId()
  const value = values[field.name]
  const hint = field.hint
    ? `<p class="field-hint">${escapeHtml(field.hint)}</p>`
    : ""
  if (field.kind === "select") {
    const placeholder = field.placeholder
      ? `<option value=""${value ? "" : " selected"}>${escapeHtml(field.placeholder)}</option>`
      : ""
    const optionList =
      typeof field.options === "function" ? field.options(ctx) : field.options
    const options = optionList
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}"${value === option ? " selected" : ""}>${escapeHtml(option)}</option>`,
      )
      .join("")
    return `
      <div class="field" data-field="${escapeHtml(field.name)}"${field.visibleWhen ? ' data-conditional="true"' : ""}>
        <label for="${id}">${escapeHtml(field.label)}</label>
        <select id="${id}" name="${escapeHtml(field.name)}">${placeholder}${options}</select>
        ${hint}
      </div>
    `
  }
  if (field.kind === "checkbox") {
    return `
      <div class="field field-checkbox" data-field="${escapeHtml(field.name)}">
        <input id="${id}" type="checkbox" name="${escapeHtml(field.name)}"${value === true ? " checked" : ""} />
        <label for="${id}">${escapeHtml(field.label)}</label>
        ${hint}
      </div>
    `
  }
  if (field.kind === "columnPicker" || field.kind === "uuidColumnPicker") {
    const all = ctx.model?.columns ?? []
    const columns =
      field.kind === "uuidColumnPicker"
        ? all.filter((column) => column.renderedType === "uuid")
        : all
    const pickers = columns
      .map(
        (column) => `
          <label class="pick">
            <input type="checkbox" name="${escapeHtml(field.name)}" value="${escapeHtml(column.name)}"${Array.isArray(value) && value.includes(column.name) ? " checked" : ""} />
            ${escapeHtml(column.name)}
          </label>
        `,
      )
      .join("")
    const body =
      columns.length === 0
        ? `<p class="field-hint">This table reports no ${field.kind === "uuidColumnPicker" ? "uuid " : ""}columns to pick from.</p>`
        : pickers
    return `
      <fieldset class="field" data-field="${escapeHtml(field.name)}">
        <legend>${escapeHtml(field.label)}</legend>
        ${body}
        ${hint}
      </fieldset>
    `
  }
  // kind === "text"
  const placeholder = field.placeholder
    ? ` placeholder="${escapeHtml(field.placeholder)}"`
    : ""
  return `
    <div class="field" data-field="${escapeHtml(field.name)}"${field.visibleWhen ? ' data-conditional="true"' : ""}>
      <label for="${id}">${escapeHtml(field.label)}</label>
      <input id="${id}" type="text" name="${escapeHtml(field.name)}" value="${escapeHtml(value ?? "")}"${placeholder} />
      ${hint}
    </div>
  `
}

/**
 * One editable create-table column row. Values are read back positionally
 * from data-col attributes, so rows carry no indexed names.
 */
export function renderColumnRow(values) {
  const nameId = fieldId()
  const typeId = fieldId()
  const nullableId = fieldId()
  const kindId = fieldId()
  const literalId = fieldId()
  const literalVisible = values.default_kind === "literal"
  return `
    <div class="column-row" data-column-row>
      <div class="field">
        <label for="${nameId}">Column name</label>
        <input id="${nameId}" type="text" data-col="name" value="${escapeHtml(values.name ?? "")}" />
      </div>
      <div class="field">
        <label for="${typeId}">Type</label>
        <select id="${typeId}" data-col="type">
          ${COLUMN_TYPE_OPTIONS(values.type)}
        </select>
      </div>
      <div class="field field-checkbox">
        <input id="${nullableId}" type="checkbox" data-col="nullable"${values.nullable === true ? " checked" : ""} />
        <label for="${nullableId}">Nullable</label>
      </div>
      <div class="field">
        <label for="${kindId}">Default</label>
        <select id="${kindId}" data-col="default_kind">
          ${DEFAULT_KIND_OPTIONS(values.default_kind)}
        </select>
      </div>
      <div class="field"${literalVisible ? "" : " hidden"} data-col-field="default_value">
        <label for="${literalId}">Literal default (JSON)</label>
        <input id="${literalId}" type="text" data-col="default_value" placeholder='"untitled", 42, true, null' value="${escapeHtml(values.default_value ?? "")}" />
      </div>
      <button type="button" class="button button-secondary column-row-remove" data-action="column-row-remove">Remove</button>
    </div>
  `
}

function optionsList(options, selected) {
  return options
    .map(
      (option) =>
        `<option value="${escapeHtml(option)}"${selected === option ? " selected" : ""}>${escapeHtml(option)}</option>`,
    )
    .join("")
}

function COLUMN_TYPE_OPTIONS(selected) {
  return optionsList(
    [
      "text",
      "integer",
      "bigint",
      "boolean",
      "uuid",
      "timestamp",
      "timestamptz",
      "date",
      "numeric",
      "jsonb",
    ],
    selected,
  )
}

function DEFAULT_KIND_OPTIONS(selected) {
  return optionsList(
    ["none", "literal", "current_timestamp", "random_uuid"],
    selected,
  )
}

/**
 * The full mutation form for one spec. The form is rendered once; app.js
 * reads values back from the DOM, toggles the conditional fields and the
 * apply button, and injects feedback into the slot at the bottom.
 */
export function renderMutationForm(spec, ctx, values, idempotencyKey) {
  const confirmField =
    spec.confirmValue === undefined
      ? ""
      : `
        <div class="field" data-field="confirm">
          <label for="mf-confirm">${escapeHtml(spec.confirmLabel)}</label>
          <input id="mf-confirm" type="text" name="confirm" autocomplete="off" />
          <p class="field-hint">Exact value: <code>${escapeHtml(spec.confirmValue(ctx))}</code></p>
        </div>
      `
  const fields =
    spec.columnRowFields !== undefined
      ? `
        <div class="field">
          <label for="mf-schema">Schema</label>
          <input id="mf-schema" type="text" name="schema" value="${escapeHtml(values.schema ?? "")}" />
          <p class="field-hint">Must be a schema the schema-admin role can create tables in.</p>
        </div>
        <div class="field">
          <label for="mf-table">Table name</label>
          <input id="mf-table" type="text" name="table" value="${escapeHtml(values.table ?? "")}" />
        </div>
        <fieldset class="field column-editor">
          <legend>Columns</legend>
          ${values.columns.map((column) => renderColumnRow(column)).join("")}
          <button type="button" class="button button-secondary" data-action="column-row-add">Add column</button>
        </fieldset>
      `
      : spec.fields.map((field) => renderField(field, values, ctx)).join("")

  return `
    <a href="#table/${encodeURIComponent(ctx.schema)}/${encodeURIComponent(ctx.table ?? "")}" class="back-link" data-action="mutation-cancel">&larr; Back to ${escapeHtml(ctx.table === undefined ? "schemas" : `${ctx.schema}.${ctx.table}`)}</a>
    <section class="panel" aria-labelledby="mutation-heading">
      <h2 id="mutation-heading">${escapeHtml(spec.heading(ctx))}</h2>
      <p class="form-description">${escapeHtml(spec.description(ctx))}</p>
      <form id="mutation-form" data-spec="${escapeHtml(spec.id)}" novalidate>
        ${fields}
        ${confirmField}
        <div class="field">
          <label for="mf-idempotency-key">Idempotency key</label>
          <input id="mf-idempotency-key" type="text" value="${escapeHtml(idempotencyKey)}" readonly />
          <p class="field-hint">Reusing a recorded key replays the recorded outcome instead of re-executing.</p>
        </div>
        <div class="form-errors" data-role="form-errors" hidden></div>
        <div class="form-actions">
          <button type="submit" class="button button-secondary" data-mode="dry-run">Dry run</button>
          <button type="submit" class="button" data-mode="apply" disabled>Apply change</button>
          <button type="button" class="button button-secondary" data-action="mutation-cancel">Cancel</button>
        </div>
      </form>
      <div class="mutation-feedback" data-role="mutation-feedback" aria-live="polite"></div>
    </section>
  `
}

/** Validation failures, announced assertively. */
export function renderFormErrors(errors) {
  const items = errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")
  return `<div class="form-error-banner" role="alert"><p>Fix the following and try again:</p><ul>${items}</ul></div>`
}

/** The dry-run preview: the command compiled and preflighted, nothing ran. */
export function renderMutationPreview(summary, idempotencyKey) {
  return `
    <div class="banner banner-preview" tabindex="-1">
      <p><strong>Dry run succeeded.</strong> ${escapeHtml(summary)}</p>
      <p class="banner-meta">Key ${escapeHtml(idempotencyKey)} &middot; nothing changed. Review the command, then apply it.</p>
    </div>
  `
}

/** The recorded outcome of a real execution. */
export function renderMutationResult(record, replayed) {
  const statements =
    record !== null &&
    typeof record.result === "object" &&
    record.result !== null &&
    typeof record.result.statement_count === "number"
      ? ` ${record.result.statement_count} statement(s) executed.`
      : ""
  const replayNote = replayed
    ? " This key was already recorded, so the recorded outcome was replayed without re-executing."
    : ""
  return `
    <div class="banner banner-success" tabindex="-1">
      <p><strong>${replayed ? "Already applied." : "Change applied."}</strong> ${escapeHtml(record === null ? "" : record.command_type)} finished with status ${escapeHtml(record === null ? "" : record.status)}.${statements}${replayNote}</p>
      <p class="banner-meta">Recorded under key ${escapeHtml(record === null ? "" : record.idempotency_key)}.</p>
    </div>
  `
}

/** A safe server failure: frozen code and message only, plus field details. */
export function renderMutationFailure(code, message, details) {
  const detailEntries =
    details !== null && typeof details === "object"
      ? Object.entries(details)
      : []
  const detailList =
    detailEntries.length === 0
      ? ""
      : `<ul>${detailEntries
          .map(
            ([field, detail]) =>
              `<li>${escapeHtml(field)}: ${escapeHtml(typeof detail === "string" ? detail : JSON.stringify(detail))}</li>`,
          )
          .join("")}</ul>`
  return `
    <div class="banner banner-error" role="alert" tabindex="-1">
      <p><strong>${escapeHtml(code)}.</strong> ${escapeHtml(message)}</p>
      ${detailList}
    </div>
  `
}

/** The 429 note for forms: never auto-submits a mutation. */
export function renderMutationRateLimited(retryAfter) {
  const wait = retryAfter === null ? "a short while" : `${retryAfter} seconds`
  return `
    <div class="banner banner-error" role="alert" tabindex="-1">
      <p><strong>RATE_LIMITED.</strong> The server is limiting admin requests. Wait ${escapeHtml(wait)} and try again.</p>
    </div>
  `
}
