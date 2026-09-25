# Management UI (I1, read-only)

The management UI is a lightweight, dependency-free static client for the
opt-in admin surface. It is served by the same Node process that runs the
API — there is no second service, no build step, and no additional runtime
dependency. It exists only when the admin lane is configured (D-012): with
`SCHEMA_DATABASE_URL` / `MICROJBASE_ADMIN_TOKEN_SHA256` absent, the whole
`/admin` surface returns the plain `404 TABLE_NOT_FOUND` of the public API,
just like `/v1/admin`.

## URLs

| Route | Purpose |
|---|---|
| `GET /admin` | Redirects (302) to `/admin/` |
| `GET /admin/` | The shell (`admin-ui/index.html`) |
| `GET /admin/assets/:name` | Styles and ES modules from `admin-ui/` |

Assets are read into memory once at startup; a missing `admin-ui/`
directory fails startup with an operator-facing error. Only files present
in the startup asset map are ever served — request paths are never resolved
against the filesystem, so traversal cannot escape the map.

## Response policy

Every UI response carries the same headers as the rest of the admin
surface: `Cache-Control: no-store` (including Fastify pre-route failures),
a restrictive `Content-Security-Policy` (`default-src 'none'`,
`script-src/style-src 'self'` — the shell ships no inline scripts or
styles), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
and `Cross-Origin-Resource-Policy: same-origin`. Static assets are not
rate-limited and do not consume the admin API budget.

## Operator token

The token is held exclusively in page memory: never in the URL,
`localStorage`, `sessionStorage`, or cookies, and never logged. Reloading
or closing the page signs the operator out. The client speaks only the
frozen V02-17 read endpoints (`docs/admin-api.md`) — the capability probe,
the schema snapshot, the table detail, and the operation history. This
release is read-only; mutation flows (V02-18, with dry-run and
confirmation) are a later increment.

## Views and states

- Schema overview: every non-system schema with classification, and per
  table its kind, exposure (exposed alias or not), RLS state, and column
  count; internal objects are badged and never presented as manageable.
- Table detail: owner, kind, classification, exposure, row-security state,
  and the columns, constraints, and standalone indexes from the snapshot.
- History: the durable operation log, newest first, with pagination.
- States: loading, empty (no schemas / empty schema / no history), error
  with retry, 401 (re-authentication), and 429 with a `Retry-After`
  countdown that re-fetches automatically.

## Tests

- Unit/component: `tests/unit/http/admin-ui/` — view models, render output
  (including escaping of hostile catalogue data), envelope classification,
  and the memory-only token store.
- E2E contract: `tests/e2e/admin-ui.test.ts` — lane gating, headers and
  content types, no-storage hygiene, and a drift guard proving the client
  references only the frozen V02-17 paths.
- Browser smoke: `tests/browser/management-ui.spec.ts` (Playwright
  Chromium) — sign-in, 401/429/error/empty states, seeded table detail,
  history, keyboard navigation, and a 360px responsive pass. Run with
  `E2E_ADMIN_DATABASE_URL=... npm run test:browser` after `npm run build`.
