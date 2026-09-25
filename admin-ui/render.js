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

export function renderLogin(errorMessage) {
  const error = errorMessage
    ? `<p class="form-error" role="alert">${escapeHtml(errorMessage)}</p>`
    : ""
  return `
    ${error}
    <form id="login-form" method="post" action="/admin/">
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
        <h2 id="schema-${escapeHtml(schema.name)}">
          ${escapeHtml(schema.name)}
          ${classificationBadge(schema.classification)}
        </h2>
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
  const columnRows =
    table.columns.length === 0
      ? '<tr><td colspan="5">This table has no reported columns.</td></tr>'
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
              </tr>
            `
          })
          .join("")

  const constraintRows =
    table.constraints.length === 0
      ? '<tr><td colspan="3">No constraints reported on this table.</td></tr>'
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
              </tr>
            `
          })
          .join("")

  const indexRows =
    table.indexes.length === 0
      ? '<tr><td colspan="4">No standalone indexes reported on this table.</td></tr>'
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
              </tr>
            `
          })
          .join("")

  return `
    <a href="#schemas" class="back-link" data-action="back-to-schemas">&larr; Back to schemas</a>
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
