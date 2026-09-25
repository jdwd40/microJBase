// Browser bootstrap for the management UI: owns the DOM, routing, and state
// transitions. All markup comes from render.js; all data comes from the
// frozen client in api.js; the operator token never leaves
// token-store.js's memory. Mutation workflows (I2) run as: fill the typed
// form, dry-run to preview, then apply; every execution carries an
// idempotency key and destructive commands require the exact confirmation.

import { createAdminClient } from "./api.js"
import {
  renderColumnRow,
  renderError,
  renderFormErrors,
  renderHistory,
  renderLoading,
  renderLogin,
  renderMutationFailure,
  renderMutationForm,
  renderMutationPreview,
  renderMutationRateLimited,
  renderMutationResult,
  renderNav,
  renderRateLimited,
  renderSchemaList,
  renderTableDetail,
  renderEmpty,
} from "./render.js"
import {
  historyViewModel,
  isEmptySnapshot,
  mutationSpec,
  newIdempotencyKey,
  summarizeSnapshot,
  tableDetailModel,
} from "./view-models.js"
import { clearToken, getToken, setToken } from "./token-store.js"

const HISTORY_PAGE_SIZE = 50

const client = createAdminClient({ getToken })

const dom = {
  layout: document.getElementById("layout"),
  loginMain: document.getElementById("login-main"),
  loginContent: document.getElementById("login-content"),
  headerActions: document.getElementById("header-actions"),
  connectionBadge: document.getElementById("connection-badge"),
  signOut: document.getElementById("sign-out"),
  nav: document.querySelector(".side-nav"),
  heading: document.getElementById("view-heading"),
  status: document.getElementById("view-status"),
  content: document.getElementById("view-content"),
}

// Session state. Nothing here is persisted; all of it dies with the page.
let snapshotCache = null
const tableCache = new Map()
let historyOffset = 0
let retryTimer = null
/** The active mutation form, or null outside the mutation flow. */
let formState = null

function announce(message) {
  dom.status.textContent = ""
  window.setTimeout(() => {
    dom.status.textContent = message
  }, 30)
}

function clearRetryTimer() {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(seconds, retry) {
  clearRetryTimer()
  const delay = Math.max(1, seconds ?? 5) * 1000
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    retry()
  }, delay)
}

function setView(html, headingText, announcement) {
  dom.heading.textContent = headingText
  dom.content.innerHTML = html
  announce(announcement ?? headingText)
  dom.heading.focus()
}

/** Prepend an apply-result banner to the freshly refreshed view and focus it. */
function showBanner(bannerHtml) {
  dom.content.insertAdjacentHTML("afterbegin", bannerHtml)
  const banner = dom.content.querySelector(".banner")
  if (banner !== null) {
    banner.focus()
  }
}

function syncHash(hash) {
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash)
  }
}

function showLogin(errorMessage) {
  clearRetryTimer()
  formState = null
  dom.layout.hidden = true
  dom.headerActions.hidden = true
  dom.loginMain.hidden = false
  dom.loginContent.innerHTML = renderLogin(errorMessage ?? null)
  const input = document.getElementById("operator-token")
  if (input !== null) {
    input.focus()
  }
}

function enterApp() {
  dom.loginMain.hidden = true
  dom.layout.hidden = false
  dom.headerActions.hidden = false
  navigate()
}

function signOut() {
  clearToken()
  snapshotCache = null
  tableCache.clear()
  historyOffset = 0
  if (window.location.hash !== "" && window.location.hash !== "#schemas") {
    window.location.hash = "#schemas"
  }
  showLogin(null)
}

/** Map a failed client result onto the shell's states. Returns true when handled as auth/rate-limit (caller stops). */
function presentFailure(result, heading, retry) {
  if (result.status === 401) {
    const message =
      result.code === "INVALID_CREDENTIALS"
        ? "The operator token was rejected. Sign in again."
        : "Sign in with the operator token."
    clearToken()
    snapshotCache = null
    tableCache.clear()
    showLogin(message)
    return true
  }
  if (result.status === 429) {
    setView(
      renderRateLimited(result.retryAfter),
      heading,
      "Rate limit exceeded; retrying automatically.",
    )
    scheduleRetry(result.retryAfter, retry)
    return true
  }
  if (result.status === 404) {
    setView(
      renderEmpty("Not found", "The requested resource no longer exists."),
      heading,
    )
    return true
  }
  setView(renderError("Something went wrong", result.message), heading)
  return false
}

function parseHash(hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (raw === "" || raw === "schemas") {
    return { view: "schemas" }
  }
  if (raw === "history") {
    return { view: "history" }
  }
  if (raw.startsWith("table/")) {
    const [, schema, table] = raw.split("/")
    if (schema && table) {
      return {
        view: "table",
        schema: decodeURIComponent(schema),
        table: decodeURIComponent(table),
      }
    }
  }
  return { view: "schemas" }
}

function updateNav(active) {
  dom.nav.innerHTML = renderNav(active)
}

async function loadSchemas(banner = null) {
  updateNav("schemas")
  const heading = "Schemas"
  if (snapshotCache === null) {
    setView(
      renderLoading("Loading schemas", "Fetching the schema snapshot…"),
      heading,
      "Loading schema snapshot.",
    )
    const result = await client.snapshot()
    if (!result.ok) {
      presentFailure(result, heading, () => loadSchemas())
      return
    }
    snapshotCache = result.data
  }
  let summary
  try {
    summary = summarizeSnapshot(snapshotCache)
  } catch (error) {
    setView(renderError("Something went wrong", error.message), heading)
    return
  }
  if (isEmptySnapshot(summary)) {
    setView(
      renderEmpty(
        "No schemas",
        "The snapshot reports no non-system schemas on this database.",
      ),
      heading,
    )
    if (banner !== null) {
      showBanner(banner)
    }
    return
  }
  setView(renderSchemaList(summary), heading)
  if (banner !== null) {
    showBanner(banner)
  }
}

async function loadTableDetail(schema, table, banner = null) {
  updateNav("schemas")
  const heading = `${schema}.${table}`
  const cacheKey = `${schema}.${table}`
  let model = tableCache.get(cacheKey)
  if (model === undefined) {
    setView(
      renderLoading("Loading table", `Fetching ${heading}…`),
      heading,
      `Loading table ${heading}.`,
    )
    const result = await client.tableDetail(schema, table)
    if (!result.ok) {
      presentFailure(result, heading, () => loadTableDetail(schema, table))
      return
    }
    try {
      model = tableDetailModel(result.data)
    } catch (error) {
      setView(renderError("Something went wrong", error.message), heading)
      return
    }
    tableCache.set(cacheKey, model)
  }
  setView(renderTableDetail(model), heading)
  if (banner !== null) {
    showBanner(banner)
  }
}

async function loadHistory() {
  updateNav("history")
  const heading = "History"
  setView(
    renderLoading("Loading history", "Fetching the operation history…"),
    heading,
    "Loading operation history.",
  )
  const result = await client.history(HISTORY_PAGE_SIZE, historyOffset)
  if (!result.ok) {
    presentFailure(result, heading, loadHistory)
    return
  }
  let view
  try {
    view = historyViewModel({ data: result.data, meta: result.meta })
  } catch (error) {
    setView(renderError("Something went wrong", error.message), heading)
    return
  }
  if (view.rows.length === 0 && view.offset > 0) {
    historyOffset = 0
    await loadHistory()
    return
  }
  setView(renderHistory(view), heading)
}

function navigate() {
  clearRetryTimer()
  formState = null
  const route = parseHash(window.location.hash)
  if (route.view === "history") {
    void loadHistory()
  } else if (route.view === "table") {
    void loadTableDetail(route.schema, route.table)
  } else {
    void loadSchemas()
  }
}

async function submitLogin(form) {
  const input = form.querySelector("#operator-token")
  const token = input === null ? "" : input.value.trim()
  if (token === "") {
    return
  }
  if (input !== null) {
    // The token lives in the store's closure from here on; never leave it
    // sitting in the hidden password control (or a password manager's save
    // prompt tied to it).
    input.value = ""
  }
  setToken(token)
  const probe = await client.capabilities()
  if (probe.ok) {
    snapshotCache = null
    tableCache.clear()
    enterApp()
    return
  }
  clearToken()
  if (probe.status === 429) {
    const wait =
      probe.retryAfter === null
        ? "a short while"
        : `${probe.retryAfter} seconds`
    showLogin(`Rate limit exceeded. Wait ${wait} and try again.`)
    return
  }
  if (probe.status === 401) {
    showLogin("The operator token was rejected. Check the token and try again.")
    return
  }
  showLogin(probe.message)
}

// --- mutation workflows (I2) ------------------------------------------------

function mutationFeedbackSlot() {
  return dom.content.querySelector('[data-role="mutation-feedback"]')
}

function mutationFormElement() {
  return dom.content.querySelector("#mutation-form")
}

function setMutationButtonsDisabled(disabled) {
  const form = mutationFormElement()
  if (form === null) {
    return
  }
  for (const button of form.querySelectorAll('button[type="submit"]')) {
    button.disabled = disabled
  }
}

function setApplyEnabled(enabled) {
  const form = mutationFormElement()
  if (form === null) {
    return
  }
  const apply = form.querySelector('button[data-mode="apply"]')
  if (apply !== null) {
    apply.disabled = !enabled
  }
}

function showFormErrors(errors) {
  const slot = dom.content.querySelector('[data-role="form-errors"]')
  if (slot === null) {
    return
  }
  slot.innerHTML = renderFormErrors(errors)
  slot.hidden = false
  slot.focus()
}

function clearFormFeedback() {
  const errors = dom.content.querySelector('[data-role="form-errors"]')
  if (errors !== null) {
    errors.hidden = true
    errors.innerHTML = ""
  }
  const feedback = mutationFeedbackSlot()
  if (feedback !== null) {
    feedback.innerHTML = ""
  }
}

/** Read the DOM form back into the spec's values model. */
function readFormValues(form, spec) {
  if (spec.columnRowFields !== undefined) {
    return {
      schema: form.elements.schema?.value ?? "",
      table: form.elements.table?.value ?? "",
      columns: [...form.querySelectorAll("[data-column-row]")].map((row) => ({
        name: row.querySelector('[data-col="name"]')?.value ?? "",
        type: row.querySelector('[data-col="type"]')?.value ?? "text",
        nullable: row.querySelector('[data-col="nullable"]')?.checked === true,
        default_kind:
          row.querySelector('[data-col="default_kind"]')?.value ?? "none",
        default_value:
          row.querySelector('[data-col="default_value"]')?.value ?? "",
      })),
    }
  }
  const values = {}
  for (const field of spec.fields ?? []) {
    if (field.kind === "checkbox") {
      values[field.name] = form.elements[field.name]?.checked === true
    } else if (
      field.kind === "columnPicker" ||
      field.kind === "uuidColumnPicker"
    ) {
      values[field.name] = [
        ...form.querySelectorAll(`input[name="${field.name}"]:checked`),
      ].map((input) => input.value)
    } else {
      values[field.name] = form.elements[field.name]?.value ?? ""
    }
  }
  if (spec.confirmValue !== undefined) {
    values.confirm = form.elements.confirm?.value ?? ""
  }
  return values
}

function toggleConditionalFields(form, spec, values) {
  for (const field of spec.fields ?? []) {
    if (field.visibleWhen === undefined) {
      continue
    }
    const wrapper = form.querySelector(`[data-field="${field.name}"]`)
    if (wrapper !== null) {
      wrapper.hidden = !field.visibleWhen(values)
    }
  }
}

/** Deterministic fingerprint of the built command; keys are built in fixed order. */
function commandFingerprint(spec, values, ctx) {
  return JSON.stringify({ spec: spec.id, input: spec.buildInput(values, ctx) })
}

/**
 * Open a typed mutation form. ctxSource comes from data-* attributes on the
 * triggering button; the table model comes from the detail cache.
 */
function openMutation(specId, source) {
  const spec = mutationSpec(specId)
  const schema = source.schema ?? ""
  const table = source.table ?? undefined
  const model =
    table === undefined ? undefined : tableCache.get(`${schema}.${table}`)
  if (table !== undefined && model === undefined) {
    return
  }
  const ctx = {
    schema,
    table,
    column: source.column ?? undefined,
    name: source.name ?? undefined,
    model,
  }
  const values = spec.initialValues(ctx)
  if (spec.columnRowFields !== undefined && schema !== "") {
    values.schema = schema
  }
  const key = newIdempotencyKey()
  formState = { spec, ctx, key, fingerprint: null }
  updateNav("schemas")
  setView(
    renderMutationForm(spec, ctx, values, key),
    spec.heading(ctx),
    spec.heading(ctx),
  )
  const form = mutationFormElement()
  if (form !== null) {
    toggleConditionalFields(form, spec, values)
  }
}

/** After a successful dry run: show the preview and arm the apply button. */
function presentDryRun(spec, ctx, key, input, fingerprint) {
  formState.fingerprint = fingerprint
  setApplyEnabled(true)
  const feedback = mutationFeedbackSlot()
  if (feedback !== null) {
    feedback.innerHTML = renderMutationPreview(spec.summarize(input, ctx), key)
    feedback.querySelector(".banner")?.focus()
  }
  announce("Dry run succeeded. Review the command, then apply it.")
}

/** After a successful apply: refresh from the server and show the record. */
async function refreshAfterApply(spec, ctx, input, outcome) {
  const banner = renderMutationResult(
    outcome.data.record,
    outcome.data.replayed,
  )
  snapshotCache = null
  tableCache.clear()
  formState = null
  switch (spec.id) {
    case "table.drop":
      syncHash("#schemas")
      await loadSchemas(banner)
      break
    case "table.create":
      syncHash(
        `#table/${encodeURIComponent(input.schema)}/${encodeURIComponent(input.table)}`,
      )
      await loadTableDetail(input.schema, input.table, banner)
      break
    case "table.rename":
      syncHash(
        `#table/${encodeURIComponent(input.schema)}/${encodeURIComponent(input.newName)}`,
      )
      await loadTableDetail(input.schema, input.newName, banner)
      break
    default:
      await loadTableDetail(ctx.schema, ctx.table, banner)
      break
  }
}

async function runMutation(mode) {
  const state = formState
  if (state === null) {
    return
  }
  const { spec, ctx, key } = state
  const form = mutationFormElement()
  if (form === null) {
    return
  }
  clearFormFeedback()
  const values = readFormValues(form, spec)
  const errors = []
  spec.validate(values, errors, ctx)
  if (
    spec.confirmValue !== undefined &&
    values.confirm !== spec.confirmValue(ctx)
  ) {
    errors.push("The confirmation does not match the exact required value.")
  }
  if (errors.length > 0) {
    showFormErrors(errors)
    return
  }
  const input = spec.buildInput(values, ctx)
  const fingerprint = commandFingerprint(spec, values, ctx)
  if (mode === "apply" && fingerprint !== state.fingerprint) {
    showFormErrors([
      "Run a successful dry run with these values before applying.",
    ])
    return
  }

  setMutationButtonsDisabled(true)
  const result = await client[spec.method]({
    ...input,
    idempotencyKey: key,
    dryRun: mode === "dry-run",
  })
  setMutationButtonsDisabled(false)
  if (formState !== state) {
    // The view moved on while the request was in flight; nothing to update.
    return
  }

  if (!result.ok) {
    if (result.status === 401) {
      clearToken()
      snapshotCache = null
      tableCache.clear()
      showLogin("The operator token was rejected. Sign in again.")
      return
    }
    const feedback = mutationFeedbackSlot()
    if (feedback !== null) {
      feedback.innerHTML =
        result.status === 429
          ? renderMutationRateLimited(result.retryAfter)
          : renderMutationFailure(
              result.code,
              result.message,
              result.details ?? null,
            )
      feedback.querySelector(".banner")?.focus()
    }
    return
  }

  if (mode === "dry-run") {
    presentDryRun(spec, ctx, key, input, fingerprint)
    return
  }
  await refreshAfterApply(spec, ctx, input, result)
}

function cancelMutation() {
  const state = formState
  formState = null
  if (state !== null && state.ctx.table !== undefined) {
    void loadTableDetail(state.ctx.schema, state.ctx.table)
    return
  }
  void loadSchemas()
}

function bindEvents() {
  dom.loginContent.addEventListener("submit", (event) => {
    const form = event.target
    if (form instanceof HTMLFormElement && form.id === "login-form") {
      event.preventDefault()
      void submitLogin(form)
    }
  })

  dom.signOut.addEventListener("click", () => {
    signOut()
  })

  window.addEventListener("hashchange", () => {
    navigate()
  })

  dom.content.addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]")
    if (control === null) {
      return
    }
    const action = control.getAttribute("data-action")
    if (action === "open-table") {
      const schema = control.getAttribute("data-schema")
      const table = control.getAttribute("data-table")
      window.location.hash = `#table/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`
    } else if (action === "back-to-schemas") {
      window.location.hash = "#schemas"
    } else if (action === "retry") {
      navigate()
    } else if (action === "history-prev") {
      historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE)
      void loadHistory()
    } else if (action === "history-next") {
      historyOffset += HISTORY_PAGE_SIZE
      void loadHistory()
    } else if (action === "mutation-open") {
      openMutation(control.getAttribute("data-spec"), {
        schema: control.getAttribute("data-schema"),
        table: control.getAttribute("data-table"),
        column: control.getAttribute("data-column"),
        name: control.getAttribute("data-name"),
      })
    } else if (action === "mutation-cancel") {
      cancelMutation()
    } else if (action === "column-row-add") {
      const editor = control.closest(".column-editor")
      if (editor !== null) {
        control.insertAdjacentHTML(
          "beforebegin",
          renderColumnRow({
            name: "",
            type: "text",
            nullable: false,
            default_kind: "none",
            default_value: "",
          }),
        )
        revalidateFingerprint()
      }
    } else if (action === "column-row-remove") {
      const row = control.closest("[data-column-row]")
      if (row !== null) {
        row.remove()
        revalidateFingerprint()
      }
    }
  })

  dom.content.addEventListener("submit", (event) => {
    const form = event.target
    if (form instanceof HTMLFormElement && form.id === "mutation-form") {
      event.preventDefault()
      const mode = event.submitter?.getAttribute("data-mode") ?? "dry-run"
      void runMutation(mode)
    }
  })

  // Editing the form after a dry run invalidates the preview: the apply
  // button drops back to disabled until a fresh dry run succeeds.
  dom.content.addEventListener("input", (event) => {
    handleFormEdit(event)
  })
  dom.content.addEventListener("change", (event) => {
    handleFormEdit(event)
  })
}

/**
 * Re-read the form and disarm apply when the built command no longer matches
 * the fingerprint of the successful dry run. Shared by the input/change
 * listener and the create-table row add/remove buttons, which mutate the DOM
 * without emitting either event.
 */
function revalidateFingerprint() {
  const state = formState
  if (state === null) {
    return
  }
  const form = mutationFormElement()
  if (form === null) {
    return
  }
  const values = readFormValues(form, state.spec)
  toggleConditionalFields(form, state.spec, values)
  if (state.fingerprint !== null) {
    const fingerprint = commandFingerprint(state.spec, values, state.ctx)
    if (fingerprint !== state.fingerprint) {
      state.fingerprint = null
      setApplyEnabled(false)
      clearFormFeedback()
    }
  }
}

function handleFormEdit(event) {
  const state = formState
  if (state === null) {
    return
  }
  const form = mutationFormElement()
  if (form === null || !form.contains(event.target)) {
    return
  }
  revalidateFingerprint()
}

function boot() {
  bindEvents()
  if (getToken() === null) {
    showLogin(null)
    return
  }
  void client.capabilities().then((probe) => {
    if (probe.ok) {
      enterApp()
    } else if (probe.status === 401) {
      clearToken()
      showLogin("Sign in with the operator token.")
    } else if (probe.status === 429) {
      showLogin("Rate limit exceeded. Wait and try again.")
    } else {
      showLogin(probe.message)
    }
  })
}

boot()
