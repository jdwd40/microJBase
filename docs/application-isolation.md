# Application isolation

Issue #28 introduces an opt-in shared installation. v0.2 data and schema
endpoints currently operate installation-wide. The private registry is the
first phase. Creating registry rows alone does not enable isolation.

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
registered schema. Global tokens, database credentials and cross-schema DDL
are operator capabilities. Filter catalogue, operation history, constraints
and foreign-key targets by the authorized scope. Disable unscoped
administration before accepting shared traffic.

The additive registry migration creates no app, copies no global exposure
and grants no memberships. Existing users, sessions and tables stay in
place. For activation, an operator must explicitly select the default app,
map every legacy exposed table, grant intended memberships, install policies
and review the resulting manifest. Reject ambiguous or missing mappings.
Cut over all legacy routes and enable the scoped routes atomically. Once
enabled, an old binary must not serve this database.

## Delivery gates

1. Private registry and constraints, installed by forward migration.
2. Transaction authorization and scoped CRUD with overlapping aliases.
   Verify disabled apps, membership revocation and connection reuse.
3. Scoped administration, validated migration manifest and atomic cutover.
4. First-party login handoff and independent browser origins. Exercise one
   login across two allowed apps and verify denial for a third.
5. Compare idle RSS and open database connections before and after enabling
   shared mode. Retain the shared runtime pool and one API process.
