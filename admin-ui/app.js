// Browser bootstrap for the management UI: owns the DOM, routing, and state
// transitions. All markup comes from render.js; all data comes from the
// frozen read-only client in api.js; the operator token never leaves
// token-store.js's memory.

import { createAdminClient } from "./api.js"
import {
  renderError,
  renderHistory,
  renderLoading,
  renderLogin,
  renderNav,
  renderRateLimited,
  renderSchemaList,
  renderTableDetail,
  renderEmpty,
} from "./render.js"
import {
  historyViewModel,
  isEmptySnapshot,
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

function showLogin(errorMessage) {
  clearRetryTimer()
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

async function loadSchemas() {
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
      presentFailure(result, heading, loadSchemas)
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
    return
  }
  setView(renderSchemaList(summary), heading)
}

async function loadTableDetail(schema, table) {
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
    }
  })
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
