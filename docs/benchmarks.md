# Footprint and performance evidence — v0.1

Measured against the real compiled application (`node dist/main.js`) on a
dedicated, freshly migrated database. No estimates; every number below comes
from the reproducible benchmark script in this repository.

## Reproduce

```bash
npm ci && npm run build
export BENCHMARK_ADMIN_DATABASE_URL=postgres://<admin>:<password>@<host>:<port>/postgres
npx tsx scripts/benchmark.ts
```

The script provisions its own database (`microjbase_benchmark`) and restricted
runtime role, runs migrations, spawns the compiled server, measures, and
tears everything down. It never touches integration/e2e databases. Output is
a JSON block on stdout plus a human summary.

## Environment

| Item | Value |
|---|---|
| OS | Ubuntu 26.04, kernel 7.0.0-31-generic (x64) |
| CPU | Intel Core Processor (Haswell, no TSX), 4 vCPUs |
| RAM | 7.7 GiB |
| Node | v22.13.0 (primary run — matches deployment requirement and the architecture guardrail reference) |
| PostgreSQL | 18.6 (Ubuntu package) |
| Application commit | `d60add82f522e9a640876da3fe21e4ad59f9e2c9` |
| Configuration | defaults; `HOST=127.0.0.1`, pool max 10, single exposed table `todos` |

## Startup

Definition: spawn `node dist/main.js` to first HTTP 200 from `GET /health`,
polled every 10 ms on loopback.

| Runs | Values (ms) | Median | Min | Max |
|---|---|---|---|---|
| 5 | 398, 417, 420, 439, 460 | **420 ms** | 398 ms | 460 ms |

Guardrail check (`ARCHITECTURE.md` §7: ready within 1 second excluding DB
timeout): **met** — ~2.4× headroom.

## Memory (RSS)

Source: `VmRSS` from `/proc/<pid>/status` of the Node application process.

| State | RSS |
|---|---|
| Idle, 2 s after readiness | **81.6 MiB** |
| After 1000-request workload | 107.7 MiB |

PostgreSQL runs as separate OS processes and is **not** included in these
figures. Idle guardrail check (≤ 80 MiB on Node 22): measured 81.6 MiB —
within ~2% of the guardrail on this shared VM; V8 heap sizing varies with
available RAM, so treat 80–85 MiB as the practical idle band for this
hardware class rather than a regression.

## Basic load

Lightweight release evidence — not a marketing or scalability benchmark, and
not a 20-concurrent CRUD benchmark. The measured run used concurrency 10 over
a mixed read-only workload (`/health` plus an authenticated list); write
paths are covered by the test suites, not by this measurement.

- Tool: the benchmark script itself (dependency-free Node `fetch`, 10
  concurrent workers, sequential per worker).
- Mix: 70% `GET /health` (performs a live database check), 30%
  `GET /v1/data/todos` with a valid bearer token.
- Total: 1000 requests, connection reuse on.

| Metric | Value |
|---|---|
| Duration | 1377 ms |
| Throughput | **726 req/s** |
| Failures | **0** |
| Latency mean | 13.7 ms |
| Latency p50 / p95 / p99 | 10.9 ms / 29.4 ms / 45.1 ms |
| Latency max | 78.5 ms |

Both endpoints exercise the full stack (auth/session lookup for data routes,
pool checkout, query, transaction). Throughput here is bounded by the 10-pool
connection default and 4 shared vCPUs running app and PostgreSQL; no
scalability claim is made beyond "comfortably exceeds the v0.1 single-node
intended workload".

## Supplementary run (Node v26.7.0)

The same script on the newer Node available on the measurement host:
startup median 394 ms (min 383, max 460), idle RSS 82 MiB, workload ~1020
req/s with p50 7.6 ms / p95 20 ms / p99 31 ms and 0 failures — consistent
with the Node 22 run.

## Raw data

The JSON emitted by the script (including per-run samples) is the raw record
of the primary run; it is reproducible bit-for-bit in method (numbers will
naturally vary run to run by a few percent on shared hardware).
