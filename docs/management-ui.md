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
frozen V02-17 read endpoints and the frozen V02-18 mutation endpoints
(`docs/admin-api.md`) — the capability probe, the schema snapshot, the table
detail, the operation history, and the typed mutation commands. Nothing else
is called, and no path is constructed from anything other than the frozen
templates plus URL-encoded operator-supplied identifiers.

## Mutation workflows (I2)

Typed UI workflows cover the supported table (create, rename, drop), column
(add, rename, drop, default set/drop, not-null/nullable, safe type change),
index (create, drop), constraint (unique add, foreign-key add, drop),
exposure (expose, unexpose), and RLS/policy (enable, disable, ownership
policy add/remove) commands. The renderer and the validator share one spec
registry (`view-models.js`), so the fields a form shows are exactly the
fields the frozen endpoint accepts; client-side validation only mirrors the
frozen allowlists, and the server remains the authority.

Every workflow is dry-run-first:

- A **Dry run** POSTs the command with `"dry_run": true` and the form's
  idempotency key; on success the preview banner states nothing changed, and
  only then does **Apply change** arm. Editing any value after a preview
  disables apply again until a fresh dry run succeeds.
- One **Idempotency-Key** is generated per form open (shown read-only). Dry
  runs never touch the server's idempotency record, so the same key
  graduates from preview to real execution; a replayed key returns the
  recorded outcome, which the result banner says explicitly.
- Destructive commands (drop table, drop column, disable row security)
  require typing the exact confirmation value (`schema.table` or
  `schema.table.column`) before either button works.
- On success the client invalidates its snapshot and table caches, refreshes
  from the server (the dropped table lands back on the overview; a rename or
  create lands on the new detail), and shows the recorded command type,
  status, and statement count. On failure only the frozen envelope is
  rendered — code, safe message, and field-level `details` — never SQL,
  SQLSTATEs, or stack traces.
- 401 signs the operator out; 429 is shown with its countdown and never
  auto-submits a mutation.

Action availability mirrors the executor: internal tables get no actions;
exposed tables get unexpose plus index/constraint management only, with a
note that structural, RLS, and policy changes need an unexpose first; the
managed `id` column and never-manageable constraints (primary key, check,
exclusion) get no buttons.

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
  the memory-only token store, and the mutation form specs (frozen
  allowlists, confirmation values, typed body building).
- E2E contract: `tests/e2e/admin-ui.test.ts` — lane gating, headers and
  content types, no-storage hygiene, and a drift guard proving the client
  references only the frozen V02-17 read and V02-18 mutation paths.
- Browser smoke: `tests/browser/management-ui.spec.ts` (Playwright
  Chromium) — sign-in, 401/429/error/empty states, seeded table detail,
  history, keyboard navigation, and a 360px responsive pass.
- Browser mutations: `tests/browser/management-ui-mutations.spec.ts` —
  create/edit with dry-run previews, the expose/unexpose lifecycle,
  destructive confirmations, sanitized server errors, auth isolation from
  ordinary session tokens, and an accessibility pass over the forms. Run
  with `E2E_ADMIN_DATABASE_URL=... npm run test:browser` after `npm run build`.
