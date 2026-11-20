import { randomBytes, createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, expect, it } from "vitest"
import { E2E_RUNTIME_ROLE } from "./helpers/config.js"
import { adminQuery } from "./helpers/database.js"
import {
  createApi,
  registerUser,
  type RegisteredUser,
  type ApiResponse,
} from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"
import { startE2EServer } from "./helpers/server.js"

let ctx: E2EContext
let alice: RegisteredUser
let existing: string
let bob: RegisteredUser
const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID()) as [
  string,
  string,
  string,
  string,
]
const callback = "https://coins.example.test/callback"
function value(response: ApiResponse, key: string): string {
  expect(response.status, response.text).toBe(201)
  return (response.body as { data: Record<string, string> }).data[key]!
}
beforeAll(async () => {
  ctx = await startE2EFile()
  alice = await registerUser(ctx.api, "alice@example.test")
  bob = await registerUser(ctx.api, "bob@example.test")
  existing = value(
    await ctx.api.post(
      "/v1/data/todos",
      { title: "before cutover" },
      alice.token,
    ),
    "id",
  )
  await ctx.server.stop()
  await adminQuery(
    "INSERT INTO microjbase.applications(id,name,schema_name,enabled,callback_url) VALUES ($1,'A','public',true,$5),($2,'B','second_app',true,null),($3,'C','third_app',true,null),($4,'D','disabled_app',false,null)",
    [a, b, c, d, callback],
  )
  await adminQuery(
    "INSERT INTO microjbase.application_memberships VALUES ($1,$3,'admin'),($2,$3,'member'),($4,$3,'admin')",
    [a, b, alice.userId, d],
  )
  await adminQuery(`CREATE SCHEMA second_app;
    CREATE TABLE second_app.todos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL);
    ALTER TABLE second_app.todos ENABLE ROW LEVEL SECURITY; ALTER TABLE second_app.todos FORCE ROW LEVEL SECURITY;
    CREATE POLICY shared_rows ON second_app.todos FOR ALL USING(true) WITH CHECK(true);
    GRANT USAGE ON SCHEMA second_app TO ${E2E_RUNTIME_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON second_app.todos TO ${E2E_RUNTIME_ROLE};
    GRANT EXECUTE ON FUNCTION microjbase.exchange_application_session(uuid,bytea,bytea),
      microjbase.authenticate_application(uuid,bytea),microjbase.resolve_application_table(text),
      microjbase.issue_application_code(uuid,bytea,bytea,text,bytea),microjbase.redeem_application_code(uuid,bytea,bytea,text,bytea),
      microjbase.application_catalogue(uuid,bytea),microjbase.set_application_visibility(uuid,bytea,text,boolean),microjbase.set_application_member(uuid,bytea,uuid,boolean) TO ${E2E_RUNTIME_ROLE}`)
  await expect(
    adminQuery("SELECT microjbase.activate_shared_mode($1)", [a]),
  ).rejects.toThrow(/unmapped/)
  for (const app of [a, b])
    await adminQuery(
      "SELECT microjbase.expose_application_table($1,'todos','todos')",
      [app],
    )
  await adminQuery("SELECT microjbase.activate_shared_mode($1)", [a])
  ctx.server = await startE2EServer()
  ctx.api = createApi(ctx.server.baseUrl)
})
afterAll(async () => {
  if (ctx) await stopE2EFile(ctx)
})

it("reuses one login across two apps and isolates CRUD, membership management and session revocation", async () => {
  const { api } = ctx
  const base = (app: string) => `/v1/apps/${app}`
  const session = async (app: string, token = alice.token) =>
    api.post(base(app) + "/session", {}, token)
  const first = value(await session(a), "token")
  expect(
    (await api.get(base(a) + "/data/todos/" + existing, first)).body,
  ).toMatchObject({
    data: { id: existing, title: "before cutover", user_id: alice.userId },
  })
  const second = value(await session(b), "token")
  for (const app of [c, d, randomUUID(), "invalid"])
    expect((await session(app)).status).toBe(401)
  expect((await api.get("/v1/data/todos", first)).status).toBe(404)
  expect((await api.get("/v1/admin/schema", first)).status).toBe(404)
  for (const path of ["/data/todos", "/data/secret"])
    expect((await api.get(base(b) + path, first)).status).toBe(401)
  expect((await api.get(base(a) + "/data/todos", alice.token)).status).toBe(401)
  expect((await api.get(base(a) + "/data/missing", first)).status).toBe(404)
  const id = value(
    await api.post(base(a) + "/data/todos", { title: "only in A" }, first),
    "id",
  )
  expect((await api.get(base(b) + "/data/todos/" + id, second)).status).toBe(
    404,
  )
  expect(
    (
      await api.patch(
        base(a) + "/data/todos/" + id,
        { title: "updated" },
        first,
      )
    ).status,
  ).toBe(200)
  expect((await api.del(base(a) + "/data/todos/" + id, first)).status).toBe(204)
  expect((await api.get(base(a) + "/admin/schema", first)).body).toMatchObject({
    data: [{ schema: "public", alias: "todos" }],
  })
  expect((await api.get(base(b) + "/admin/schema", second)).status).toBe(401)
  const exposure = base(a) + "/admin/exposures/todos"
  expect((await api.del(exposure, first)).status).toBe(204)
  expect((await api.get(base(a) + "/data/todos", first)).status).toBe(404)
  expect((await api.get(base(b) + "/data/todos", second)).status).toBe(200)
  expect(
    (
      await api.send("PUT", exposure, undefined, {
        authorization: `Bearer ${first}`,
      })
    ).status,
  ).toBe(204)
  const member = (app: string) => base(app) + "/admin/members/" + bob.userId
  expect(
    (
      await api.send("PUT", member(b), undefined, {
        authorization: `Bearer ${second}`,
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await api.send("PUT", member(a), undefined, {
        authorization: `Bearer ${first}`,
      })
    ).status,
  ).toBe(204)
  const bobToken = value(await session(a, bob.token), "token")
  expect((await api.get(base(a) + "/data/todos", bobToken)).status).toBe(200)
  expect((await api.del(member(a), first)).status).toBe(204)
  expect((await api.get(base(a) + "/data/todos", bobToken)).status).toBe(401)
})

it("binds a one-time login handoff to its callback, verifier, audience and live parent session", async () => {
  const user = await registerUser(ctx.api, "handoff@example.test")
  await adminQuery(
    "INSERT INTO microjbase.application_memberships VALUES ($1,$2,'member')",
    [a, user.userId],
  )
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const authorize = (url: string) =>
    ctx.api.post(
      `/v1/apps/${a}/authorize`,
      { callback: url, challenge },
      user.token,
    )
  expect((await authorize("https://other.example.test")).status).toBe(401)
  const code = value(await authorize(callback), "code")
  const redeem = (app: string, proof: string) =>
    ctx.api.post(`/v1/apps/${app}/redeem`, { callback, verifier: proof }, code)
  expect((await redeem(b, verifier)).status).toBe(401)
  expect((await redeem(a, randomBytes(32).toString("base64url"))).status).toBe(
    401,
  )
  const token = value(await redeem(a, verifier), "token")
  expect((await redeem(a, verifier)).status).toBe(401)
  expect((await ctx.api.get(`/v1/apps/${a}/data/todos`, token)).status).toBe(
    200,
  )
  expect((await ctx.api.post("/v1/auth/logout", {}, user.token)).status).toBe(
    204,
  )
  expect((await ctx.api.get(`/v1/apps/${a}/data/todos`, token)).status).toBe(
    401,
  )
})
