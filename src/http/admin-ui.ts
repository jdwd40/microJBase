// Same-process static hosting for the management UI shell (V02-17 client).
//
// The read-only management UI is a dependency-free static client living in
// admin-ui/ at the repository root. This module serves it from the same
// Fastify process — there is no second service and no additional runtime
// dependency. Assets are read into memory once at registration, so a missing
// or incomplete admin-ui directory fails startup loudly instead of serving
// 500s later.
//
// Registration is gated on the admin lane exactly like the /v1/admin tree
// (D-012): with the lane disabled no /admin route exists, the paths fall
// through to the plain 404, and the opted-out server leaves no fingerprint.
//
// Response policy, matching the rest of the admin surface:
//   - Cache-Control: no-store on every response (pre-route failures included,
//     via the server onSend hook's /admin prefix match);
//   - a restrictive Content-Security-Policy — the shell ships no inline
//     scripts or styles, so script-src/style-src 'self' is exact;
//   - nosniff, no-referrer, and same-origin resource isolation.
//
// Only names present in the startup-built asset map are ever served; request
// paths are never joined onto the filesystem, so traversal cannot escape the
// map even if URL decoding is hostile.

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { FastifyInstance, FastifyReply } from "fastify"

import { AppError } from "../core/index.js"

// src/http/admin-ui.ts (development, tsx) and dist/http/admin-ui.js (compiled
// npm start) both sit two levels below the repository root, where admin-ui/
// ships next to package.json — the deployment layout is a whole-repo clone.
const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "admin-ui",
)

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
}

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; " +
  "img-src 'none'; font-src 'none'; connect-src 'self'; media-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

interface UiAsset {
  content: Buffer
  contentType: string
}

function loadAssets(): Map<string, UiAsset> {
  let entries
  try {
    entries = readdirSync(UI_DIR, { withFileTypes: true })
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      `Management UI assets not found at ${UI_DIR}; the admin-ui directory must ship with the deployment`,
      400,
    )
  }
  const assets = new Map<string, UiAsset>()
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const contentType = CONTENT_TYPES[path.extname(entry.name)]
    if (contentType === undefined) {
      continue
    }
    assets.set(entry.name, {
      content: readFileSync(path.join(UI_DIR, entry.name)),
      contentType,
    })
  }
  if (!assets.has("index.html")) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Management UI assets are incomplete: admin-ui/index.html is missing",
      400,
    )
  }
  return assets
}

function applyUiHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("content-security-policy", CONTENT_SECURITY_POLICY)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("cross-origin-resource-policy", "same-origin")
}

/** Register GET /admin, GET /admin/, and GET /admin/assets/:name. */
export async function registerAdminUi(app: FastifyInstance): Promise<void> {
  const assets = loadAssets()
  const index = assets.get("index.html") as UiAsset

  app.get("/admin", async (_request, reply) => {
    applyUiHeaders(reply)
    return reply.redirect("/admin/", 302)
  })

  app.get("/admin/", async (_request, reply) => {
    applyUiHeaders(reply).type(index.contentType)
    return reply.send(index.content)
  })

  app.get<{ Params: { name: string } }>(
    "/admin/assets/:name",
    async (request, reply) => {
      const asset = assets.get(request.params.name)
      if (asset === undefined) {
        return reply.callNotFound()
      }
      applyUiHeaders(reply).type(asset.contentType)
      return reply.send(asset.content)
    },
  )
}
