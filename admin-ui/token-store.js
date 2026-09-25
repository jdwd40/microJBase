// In-memory-only operator token store for the management UI (V02-17 client).
//
// The token lives exclusively in this module's closure for the lifetime of
// the page. It is never written to the URL, localStorage, sessionStorage,
// cookies, or any other persistent browser surface, and it is never logged.
// Reloading or closing the page destroys it; signing out clears it together
// with every fetched data cache.

let operatorToken = null

/** Remember the operator token for this page only. */
export function setToken(token) {
  operatorToken = token
}

/** The current operator token, or null when signed out. */
export function getToken() {
  return operatorToken
}

/** Sign out: drop the token so no further request can carry it. */
export function clearToken() {
  operatorToken = null
}
