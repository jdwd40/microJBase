# Running multiple applications on microJBase

Shared mode uses one Fastify process, one PostgreSQL database and a single
user directory. Existing installations enter shared mode only after the
operator explicitly maps their existing tables and activates the default app.

## Identity and deployment boundary

Keep one users table and one login service. A trusted first-party gateway
holds the user's existing global session server-side. Frontends on different
domains redirect to the gateway for login. Register each application's exact
HTTPS callback in advance. Exchange a short-lived, single-use code bound to
the callback, application, session and PKCE verifier for an opaque
app-limited credential. Each domain uses its own secure HttpOnly session
cookie and CSRF protection. The browser never receives a reusable global
credential during this flow. Do not forward a bearer token in a URL or allow
wildcard credentialed CORS. Keep third-party registration closed.

## Data contract

Use an explicit app UUID in the route. Match the credential audience to it,
check the global session is live, and load the active application. Private
apps require a current membership. An open app accepts an authenticated
member of the global installation with ordinary data privileges. Only an
explicit admin membership grants app administration. Resolve the alias after
this check. Use the same response for absent, disabled and inaccessible apps.
Reject an unscoped data request in shared mode.

Each application owns a single schema. The registry enforces a unique schema
per app and one physical target per alias within it. Exposures contain no
independent schema field. Keep identifier validation, catalogue verification,
runtime-role checks, forced RLS and the existing row-owner policy. Add a
restrictive app policy to each exposed table with both USING and WITH CHECK.
Bind the app UUID and authenticated user UUID using transaction-local
set_config on the same checked-out PostgreSQL client as the membership,
alias and data queries. Serialize revocation and exposure changes against
in-flight authorization checks. Verify both commit and rollback on a pool of
one before enabling shared mode.

## Administration and upgrade

An operator registers apps, assigns schemas and seeds administrators.
App admins can manage ordinary memberships and exposures only within their
registered schema. App administrators see only that application’s approved
tables. Installation-wide history and DDL remain operator-only. The API
rejects application tables with cross-schema foreign keys, apart from links
to global users. Operators must review triggers and policies for cross-app
side effects before exposing a table.

The additive registry migration creates no app, copies no global exposure
and grants no memberships. Existing users, sessions and tables stay in
place. For activation, an operator must explicitly select the default app,
map every legacy exposed table, grant intended memberships, install policies
and review the resulting manifest. Reject ambiguous or missing mappings.
Cut over all legacy routes and enable the scoped routes atomically. Once
enabled, an old binary must not serve this database.

## Operator setup and cutover

Back up the database and rehearse on a restored copy. Install the current
binary and run all migrations. Start it once in legacy mode so it imports
the existing exposure registry. Stop **all** API instances before cutover.
Use a database-owner session for the following examples. Substitute your
own schema, aliases, global user UUIDs and role names.

In psql, register the existing application, select its schema and seed the
first admin. For intentionally open applications set
`open_to_authenticated=true`. Private membership is the default.

```sql
BEGIN;
INSERT INTO microjbase.applications(name,schema_name,enabled,callback_url)
VALUES ('Coins','public',true,'https://coins.example.com/login/callback')
RETURNING id AS coins_id \gset
INSERT INTO microjbase.application_memberships(app_id,user_id,role)
VALUES (:'coins_id', :'owner_user_id','admin');
SELECT alias,schema_name,table_name FROM microjbase.exposure_registry WHERE exposed;
SELECT microjbase.expose_application_table(:'coins_id','todos','todos');
GRANT EXECUTE ON FUNCTION
  microjbase.resolve_application_table(text),
  microjbase.exchange_application_session(uuid,bytea,bytea),
  microjbase.authenticate_application(uuid,bytea),
  microjbase.issue_application_code(uuid,bytea,bytea,text,bytea),
  microjbase.redeem_application_code(uuid,bytea,bytea,text,bytea),
  microjbase.set_application_member(uuid,bytea,uuid,boolean),
  microjbase.application_catalogue(uuid,bytea),
  microjbase.set_application_visibility(uuid,bytea,text,boolean)
TO microjbase_runtime;
SELECT microjbase.activate_shared_mode(:'coins_id');
COMMIT;
```

Call the exposure function once per legacy alias. Activation refuses a
missing alias, mismatched physical table or absent restrictive policy. A
legacy installation spanning multiple schemas must consolidate its default
app's tables first or explicitly retire mappings before activation. The
transaction can be rolled back before commit. Following commit, rollback
means restoring the pre-cutover backup and matching binary/config. Restart
with the global schema-admin token and schema database URL unset. The global
login, sessions and row data survive. The old global data routes and schema
UI are disabled. Never run an older binary against an activated database.

Register each additional app with its own operator-owned schema. Create its
tables with a UUID primary key named id, appropriate owner or sharing
policies, ENABLE and FORCE ROW LEVEL SECURITY. Grant the runtime role USAGE
on that schema and the required table CRUD privileges. Then call
`expose_application_table(app_uuid, alias, physical_table_name)`.
Keep schema CREATE and DDL privileges away from runtime and app admins.
Only the operator can register physical tables, appoint app admins or
perform structural DDL. Use the scoped visibility endpoint to hide or show
an already approved table. Set `enabled=false` to disable an entire app.
Do not grant runtime direct registry writes or access to the internal
identity-binding function.

## Client endpoints

All paths below start with `/v1/apps/{app_uuid}`. Use HTTPS. Application
tokens expire after at most 15 minutes. A new exchange for the same global
session and app replaces the old app token. Other apps are unaffected.

| Method and path | Credential and effect |
| --- | --- |
| POST /session | A trusted gateway sends the global bearer to obtain an app token. |
| POST /authorize | The login gateway sends the global bearer and JSON callback and challenge. Returns a one-time code valid for 60 seconds. |
| POST /redeem | The app backend sends that code as the bearer plus JSON callback and verifier. Returns an app token. |
| GET or POST /data/{alias} | List or create using the app token and the existing data API format. |
| GET, PATCH or DELETE /data/{alias}/{id} | Read, edit or delete the row within this app. |
| GET /admin/schema | App admin lists only its own approved tables and visibility. |
| PUT or DELETE /admin/members/{user_uuid} | App admin grants or removes ordinary membership. Only the operator can appoint or remove admins. |
| PUT or DELETE /admin/exposures/{alias} | App admin shows or hides an operator-approved mapping. |

For separate origins, each app backend generates a fresh random PKCE
verifier and independent state nonce and stores them in the initiating
browser's server-side session. Send its base64url SHA-256 challenge and
registered callback to the trusted login gateway. After login, the gateway
calls /authorize, then redirects only to that exact registered callback
with the code and original state. The app backend validates state once,
redeems the code using the saved verifier and keeps the returned credential
server-side. Use secure HttpOnly cookies, CSRF protection, a callback page
without third-party assets and a no-referrer policy. Exclude callback query
strings from proxy and application logs. Code redemption is single-use.
A global logout or loss of app access invalidates subsequent data requests.
This setup needs no credentialed cross-origin browser API access. Registration
and redirect origins are operator-controlled.

## Footprint

Three paired Linux runs used Node 22.13, PostgreSQL 17.11, the compiled API
and the same database before and after activating two enabled apps with
exposures. Each fresh server answered its readiness check and then idled
for one second before sampling VmRSS in /proc and counting connections for
the runtime role in pg_stat_activity. Median RSS was 85.23 MiB in legacy
mode and 87.59 MiB in shared mode (increase 2.36 MiB); both had one idle
runtime database connection. These short samples exceed the 80 MiB target.
The default runtime pool limit remains ten. No runtime dependency was added.
