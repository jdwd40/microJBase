# Agent Instructions

These rules apply to every coding agent working in this repository, including Hermes/OpenCode/Kimi and Grok review bots.

## 1. Before changing anything

Read, in order:

1. `README.md`
2. `docs/v0.1-scope.md`
3. `ARCHITECTURE.md`
4. `CONTRACTS.md`
5. the relevant file under `docs/`
6. `DECISIONS.md`

Then inspect the current code and tests. Do not assume the task description is newer than the repository documents.

## 2. Scope discipline

- Work only on the task and owned paths named in the assignment.
- Do not implement deferred features “for completeness.”
- Do not change public contracts, architecture, dependencies, migrations owned by another task, or unrelated formatting.
- If a contract is insufficient, document the exact blocker for the integrator; do not invent a parallel contract.
- Preserve existing user changes and keep commits reviewable.
- Never commit secrets, generated build output, coverage, local databases, or `.env` files.

## 3. Default task ownership

| Task | Owned paths | Must not edit |
|---|---|---|
| Architect/integrator | `src/contracts/**`, `src/main.ts`, root config/docs | feature internals except integration fixes |
| Core/config agent | `src/core/**`, matching unit tests | contracts, feature modules |
| Auth agent | `src/auth/**`, auth unit tests | database and HTTP implementations |
| Database agent | `src/database/**`, `migrations/**`, DB tests | auth/data service internals |
| Data agent | `src/data/**`, data unit tests | database implementation and HTTP |
| HTTP agent | `src/http/**`, HTTP tests | SQL, password/session internals |
| Test/review agent | `tests/**`, review reports | production code unless explicitly tasked |

The integrator may narrow ownership further for a task. Task-specific instructions win.

## 4. Implementation rules

- TypeScript strict mode; do not use `any` unless an external boundary forces it and the reason is documented.
- Prefer small explicit functions over abstractions intended for hypothetical future features.
- Keep runtime dependencies minimal. A new runtime dependency needs an explicit justification and integrator approval.
- SQL values must be parameterised. Dynamic identifiers must come only from the verified table registry and be safely quoted.
- Use transactions for every request that sets `microjbase.user_id`.
- Never log passwords, raw bearer tokens, password hashes, session hashes, or full database URLs.
- Use stable error codes from `CONTRACTS.md`; do not expose raw PostgreSQL errors.
- Migrations are forward-only and immutable after merging.
- Do not weaken RLS, table allowlisting, runtime-role checks, or auth tests to make a test pass.

## 5. Required completion evidence

Every implementation task must report:

- files changed;
- tests added or updated;
- exact verification commands and results;
- any contract or security concerns;
- measured footprint impact if runtime dependencies changed.

Before marking a task complete, run the narrow tests for the module plus the repository's standard lint, typecheck, and test commands once those scripts exist.

## 6. Review roles

### Grok Red: adversarial review

Focus on exploitability and incorrect assumptions:

- auth bypass, session leakage, timing/user enumeration;
- SQL injection through table/column identifiers;
- RLS bypass or pooled-connection identity leakage;
- unsafe proxy/IP trust, logging, errors, and configuration;
- denial-of-service through input sizes or unbounded memory;
- cross-module contract violations.

Report findings with severity, evidence, reproduction, and smallest safe fix. Do not make speculative redesigns.

### Grok Green: compliance and regression audit

Check:

- implementation against scope, architecture, and contracts;
- tests for happy paths, boundaries, and failures;
- migrations on a clean database and on the previous version;
- lint/typecheck/test/benchmark results;
- documentation drift and unnecessary dependencies.

### Kimi/OpenCode: primary implementation

Implement one bounded task at a time. Ask the integrator to resolve ambiguities between documents before editing across module boundaries.

## 7. Definition of done

A task is done only when its acceptance criteria pass, its relevant tests exist, no unrelated files changed, and the handoff contains enough evidence for another agent to reproduce the result.

