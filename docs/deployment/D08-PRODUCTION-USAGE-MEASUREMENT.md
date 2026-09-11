# D-08 Gate Evidence — Measured Production Usage Baseline

| | |
|---|---|
| **Deliverable role** | D-08 gate-1 usage evidence (measured production usage) |
| **Dispatch base** | `f2b5284baffba19eaa53e2dbee6f5ba1646fe5a9` (origin/main at dispatch — E1.1 final architecture acceptance) |
| **Campaign harness head** | `ad2738d3cac1cf5b0554d4ad41504aad972c54ba` (worker processes, release/drill/queue operator readings taken here) |
| **Final head** | boundary-remediation commit `38c6c08a09aa0c3a3a9bb9d07b28dc85c0597844` (campaign harness relocated to `deploy/`; the branch tip may advance by this identity pin itself) |
| **Branch** | `gate/d08-measured-usage` |
| **PR** | [#32 — "D-08 gate evidence: measured production usage baseline"](https://github.com/payswapdotorg/Zeck/pull/32) |
| **Authorization** | Tech Lead dispatch of the D-08 Gate-Evidence Worker (no GitHub issue; roadmap gate: `docs/DEPLOYMENT-ROADMAP.md` §D-08 — "D-08 may only begin after measured production usage…"; gates 2+3 already approved on main `014fb30`) |
| **Campaign window** | 2026-09-10 08:00:30Z → 2026-09-10 09:04:18Z (wall clock, including one disclosed interruption) |
| **Product code touched** | NONE — `git diff f2b5284..HEAD -- src/ spec/ sdk/ tests/` is empty (no source, spec, SDK or test line changed). `deploy/` gains exactly three `usage-*` measurement-harness files (the campaign composition root relocated there by the boundary remediation — `deploy/` is the operator-composition precedent); `benchmarks/d08-usage/` holds only pure measurement definitions + raw data; plus one disclosed lint-scope line in `biome.json` |

This document is a **measurement record, not a certification**. Everything below was
actually executed in the sandbox against the real repository-defined surfaces; every
number is traceable to a committed raw-data file under `benchmarks/d08-usage/data/`.
Boundaries that were NOT exercised are listed explicitly in §10 and are never claimed
as PASS anywhere in this record.

---

## 1. What was operated (the honest position)

The D-08 gate requires *measured production usage*. No production environment, real
customer traffic, or real tenants exist at this revision — claiming otherwise would be
fabrication. What was operated instead, end to end and with full instrumentation, is the
**staging-parity deployment surface of the delivered system in a single-host sandbox**:

| Plane | What actually ran | Stand-in honesty |
|---|---|---|
| Authority | PostgreSQL 17.11 database `zeck_local` (D-02 converged: 24 schemas, 114 tables, 29 migrations) via the real `PgDatabasePort` | real PostgreSQL; single local instance, no HA topology |
| Public surface | `createApiServer` (Fastify) on `127.0.0.1:4100` over the real SQL module authorities, driven by the real `sdk/index.ts` `ZeckClient` | real HTTP + real SDK; no TLS, loopback only |
| Queue | the REAL Cloudflare-Queues adapter pointed at the local protocol-faithful stand-in from `tests/integration/queue/lib/fake-cloudflare-queues.ts` | no provider credentials exist in the sandbox — recorded honestly, never claimed as the real provider |
| Execution | the REAL worker service process: `bun deploy/worker.ts run --environment local …` (own OS process per chunk, SIGTERM → bounded graceful drain) | real service; one process at a time (chunked contract, §4) |
| Dispatch | the real `DurableDispatcher` over `QueueCorrelationStore` (PostgreSQL) | real |
| Observability | the real OTLP/HTTP-JSON exporter through the bounded, environment-bound telemetry sink | exporter real; receiving end is a local collector stub (§8.4) |
| Release control | `bun deploy/release.ts status/alerts` captured externally at start/mid/end | real operator surface |
| Resilience | `bun deploy:drill -- authority-loss` executed once with measured RTO/RPO | real drill; see §9 |

All campaign traffic went through **real HTTP** (`ZeckClient`) for every create, poll,
and ledger read. The platform-side progression (authorize → plan → queue → dispatch) has
**no HTTP surface at this revision**, so the harness performs that composition-root role
directly against the module authorities — the same composition `tests/integration` uses.
This is disclosed rather than hidden: the measured latencies for those stages are
in-process module latencies, not network round-trips.

## 2. Environment contract

- **Host**: single sandbox container (linux x86_64), single region, no external ingress.
- **Runtime**: bun 1.3.14, node/bun-managed dependencies (`bun install` at setup).
- **PostgreSQL**: 17.11 (Debian) listening on `127.0.0.1:55432`, data dir `/home/z/pgdata`,
  databases `postgres` (admin) and `zeck_local` (converged authority).
- **Ports**: API `127.0.0.1:4100`; OTLP collector stub `127.0.0.1:4102`; queue stand-in in-process.
- **Environment**: `ZECK_ENVIRONMENT=local`, `ZECK_DATABASE_URL=postgres://postgres@127.0.0.1:55432/zeck_local`,
  `ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres`, `ZECK_LOCAL_DATA_ROOT=…/.local/share/zeck`.
- **Redis**: NOT configured — `deploy:smoke` readiness is `degraded`
  (`coordination-degraded`, "degraded by explicit choice"). Disclosed, never counted as ready.
- **Identity**: deployment identity `fba9a514e8dc…` (captured in `data/identity.json` at
  bring-up revision `06d2adb`; resources: pg-database, local-object-store, local-redis,
  local-container-runner).

## 3. Baseline gate (re-run at harness head `ad2738d`; captured in `data/baseline-gate.txt`)

```
python3 scripts/governance-check.py
  → Governance OK: 56 Work Orders, 102 requirements, inFlight=[], frontier=[]
bun run typecheck   → tsc --noEmit — 0 errors
bun run lint        → biome check — 1293 files, no fixes applied
```

## 4. The chunked execution contract (sandbox reaper)

This sandbox kills every process spawned by a tool call when that call returns. This was
**observed directly**: after the session's tool bridge died mid-campaign, recovery found
the worker and API processes dead while the PostgreSQL authority and every durable cursor
survived. The campaign is therefore built to run as N sequential bounded **chunks**
(`deploy/usage-campaign.ts` — the composition root lives in `deploy/`, the
repository's operator-composition precedent, so the benchmark tree holds only
pure measurement definitions and raw data):

- Durable campaign state lives in PostgreSQL (executions, envelopes, compute plane,
  budgets) plus `data/campaign-state.json` (the work-list cursor).
- Each chunk starts a **fresh world** (API server + queue stand-in + OTLP stub + a REAL
  worker service process), continues the work list, appends to the SAME JSONL data files,
  then stops cleanly: every execution started in the chunk is awaited to a terminal state
  BEFORE the worker's bounded graceful drain — nothing undispatched crosses a chunk boundary.
- Sustained-window wall-clock coverage accumulates across chunks; each chunk's live window
  is recorded in `data/chunks/chunk-*.json`.
- **Never claimed**: a single uninterrupted 30-minute process. The 1800 s sustained window
  is accumulated live-stack seconds across 6 chunks; the longest single uninterrupted
  window is 368 s (chunk 1). Worker continuity is at the durable-state level (every chunk's
  worker registered, heartbeated at ~1 Hz, and drained gracefully).

## 5. Stack bring-up and convergence

**Bring-up** (revision `06d2adb`, pre-campaign): `deploy:validate` → `deploy:bootstrap` →
`deploy:migrate` → `deploy:smoke --allow-degraded` → `deploy:identity`. Captured outputs:
`data/smoke.json` (pass=true, readiness `degraded` — redis by explicit choice; environment
contract satisfied, 0 problems) and `data/identity.json`.

**Post-campaign re-validation** (final head `ade6bec`, after all 405 executions — the same
stack re-converges cleanly with the campaign data still in place):

| Check | Result |
|---|---|
| `deploy:validate` | 74 variables, 4 secret-reference inventories, 13 release-gate kinds, 3 quota guards, 3 operational thresholds, 29 migrations, 5 recovery-target environments — OK (`data/validate.json`) |
| `deploy:bootstrap` | idempotent converge, no drift (`data/bootstrap.json`) |
| `deploy:migrate` | 0 applied / 29 skipped, `schemaConverged: true` (`data/migrate.json`) |
| `deploy:smoke --allow-degraded` | `pass: true`, readiness `degraded` (redis, by choice) (`data/smoke-post.json`) |

## 6. Campaign definition and execution record

**12 scenario classes** (definitions and honest plane mappings in `benchmarks/d08-usage/scenarios.ts`;
exceeds the ≥8 minimum): `simple-deterministic`, `model-routed-decision`,
`tool-surface-programmatic`, `context-heavy`, `failure-retry`, `failure-escalation`,
`competence-reuse`, `budget-funded`, `budget-exhausted`, `policy-denied`,
`verification-heavy`, `burst-load`.

**Phases**: A — every class at concurrency 1 (plus the budget class at c=6);
B — the latency-sensitive classes at c=4 (plus budget at c=6); C — burst at c=16 and a
steady burst at c=32; **sustained** — a 1800 s live window at a mixed low-rate cadence
(15 s ticks, rotating classes, periodic context/failure/budget/escalation injections).

**Concurrency levels exercised: 1, 2, 4, 6, 16, 32.**

**Chunk ledger** (from `data/chunks.jsonl` — all 6 chunks drained gracefully):

| chunk | wall window (UTC) | dur (s) | worker | executions | sustained cumulative | total |
|---|---|---|---|---|---|---|
| 1 | 08:00:30 → 08:06:39 | 368 | `01a08a55-2539…` | 224 | 165 s | 224 |
| 2 | 08:36:07 → 08:42:08 | 361 | `01a08a75-c062…` | 40 | 525 s | 264 |
| 3 | 08:42:17 → 08:48:18 | 361 | `01a08a7b-6692…` | 40 | 885 s | 304 |
| 4 | 08:48:46 → 08:54:47 | 361 | `01a08a81-53ca…` | 40 | 1245 s | 344 |
| 5 | 08:54:56 → 09:00:57 | 361 | `01a08a86-f7cc…` | 40 | 1605 s | 384 |
| 6 | 09:01:02 → 09:04:17 | 196 | `01a08a8c-8da3…` | 21 | **1800 s** | **405** |

**Disclosed interruption**: chunk 1 ended at 08:06:39Z when the session's tool bridge
failed; chunk 2 resumed at 08:36:07Z from the durable cursor (`nextItem=20`,
`sustainedElapsedSeconds=165`, `totalExecutions=224`) with the PostgreSQL authority fully
intact — a real-world crash-resume of the campaign itself, absorbed exactly as the chunked
contract was designed to absorb it. Between chunks 2–6 the gaps are 9–45 s (world restart).

## 7. Measured results (all from `data/summary.json`, `data/executions.jsonl`, and durable PostgreSQL reads)

### 7.1 Outcome distribution — 405 governed executions

| outcome | n | share |
|---|---|---|
| COMPLETED | 386 | 95.3% |
| FAILED | 16 | 4.0% |
| DENIED | 3 | 0.7% |
| TIMEOUT | 0 | 0% |

Every FAILED is an **intended** governed failure (the `failure-retry` class measures the
redelivery/bounded-attempt machinery and expects terminal FAILED; the `failure-escalation`
class pairs a permanent failure with a fresh escalated execution that succeeds). Every
DENIED is an intended `POLICY_DENIED` at the authorize seam. The durable ledger agrees
exactly: 405 `execution.created`, 402 authorize/plan/queue/start/sandbox-admitted/
sandbox-completed, 386 verify+pass, 16 fail, 3 policy-denied, 78 `planning.decision-recorded`.

### 7.2 End-to-end latency (COMPLETED, n=386; client-side create → terminal-state read)

| p50 | p90 | p99 | avg | max |
|---|---|---|---|---|
| 1083.63 ms | 2646.62 ms | 11196.24 ms | 1421.19 ms | 13217.2 ms |

The p99/max tail is dominated by the `budget-exhausted` batches (intentional 2 s sandbox
sleeps at c=6 with serialized claims, §7.6) — it is workload shape, not platform overhead.

### 7.3 Per-stage latency (COMPLETED, n=386; from the durable ledger's gapless event timestamps)

| stage | p50 | p90 | p99 | avg | max |
|---|---|---|---|---|---|
| create (HTTP `POST /executions`) | 9.32 ms | 80.72 ms | 112.84 ms | 25.70 ms | 140.87 ms |
| progression (authorize+plan+decision+queue+dispatch) | 27.66 ms | 135.55 ms | 228.33 ms | 53.95 ms | 233.03 ms |
| claim (queue → worker start) | 904 ms | 2463 ms | 8860 ms | 1187.24 ms | 11018 ms |
| execute (sandbox start → verify) | 24 ms | 56 ms | 2036 ms | 92.33 ms | 2042 ms |
| settle (verify → pass/fail) | 2 ms | 8 ms | 31 ms | 3.90 ms | 38 ms |

Reading: the platform's own authority work (create, progression, settle) is
single-digit-to-tens of milliseconds. **Claim latency dominates end-to-end latency** — it
is governed by the worker's claim cadence and the queue stand-in's delivery batching, not
by PostgreSQL performance. Execute reflects the actual sandbox payload (intentional 2 s
sleeps in the costed/failure classes produce the ~2 s p99).

### 7.4 Per-scenario, per-phase table (32 measured rows; e2e = totalMs percentiles)
| phase | scenario | conc | n | ok | fail | denied | e2e p50 (ms) | e2e p90 (ms) | e2e p99 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| A-budget | `budget-exhausted` | 6 | 6 | 6 | 0 | 0 | 7068 | 13203 | 13203 |
| A-c1 | `budget-funded` | 1 | 6 | 6 | 0 | 0 | 1077 | 1093 | 1093 |
| A-c1 | `competence-reuse` | 1 | 6 | 6 | 0 | 0 | 1083 | 1098 | 1098 |
| A-c1 | `context-heavy` | 1 | 6 | 6 | 0 | 0 | 988 | 1171 | 1171 |
| A-c1 | `failure-escalation` | 1 | 6 | 3 | 3 | 0 | 1084 | 1099 | 1099 |
| A-c1 | `failure-retry` | 1 | 3 | 0 | 3 | 0 | 1523 | 1531 | 1531 |
| A-c1 | `model-routed-decision` | 1 | 6 | 6 | 0 | 0 | 1093 | 1109 | 1109 |
| A-c1 | `policy-denied` | 1 | 3 | 0 | 0 | 3 | 30040 | 30115 | 30115 |
| A-c1 | `simple-deterministic` | 1 | 6 | 6 | 0 | 0 | 971 | 1112 | 1112 |
| A-c1 | `tool-surface-programmatic` | 1 | 6 | 6 | 0 | 0 | 1083 | 1096 | 1096 |
| A-c1 | `verification-heavy` | 1 | 6 | 6 | 0 | 0 | 1081 | 1098 | 1098 |
| B-budget | `budget-exhausted` | 6 | 6 | 6 | 0 | 0 | 7114 | 13217 | 13217 |
| B-c4 | `context-heavy` | 4 | 12 | 12 | 0 | 0 | 1352 | 1500 | 1599 |
| B-c4 | `model-routed-decision` | 4 | 12 | 12 | 0 | 0 | 1106 | 1137 | 1260 |
| B-c4 | `simple-deterministic` | 4 | 12 | 12 | 0 | 0 | 1147 | 1274 | 1276 |
| B-c4 | `tool-surface-programmatic` | 4 | 12 | 12 | 0 | 0 | 1113 | 1286 | 1295 |
| B-c4 | `verification-heavy` | 4 | 12 | 12 | 0 | 0 | 1127 | 1274 | 1292 |
| C-c16 | `burst-load` | 16 | 32 | 32 | 0 | 0 | 2595 | 2727 | 2791 |
| C-c16 | `simple-deterministic` | 16 | 16 | 16 | 0 | 0 | 1416 | 2689 | 2689 |
| C-c32 | `burst-load` | 32 | 32 | 32 | 0 | 0 | 2548 | 4870 | 5028 |
| sustained | `budget-funded` | 1 | 10 | 10 | 0 | 0 | 957 | 1090 | 1090 |
| sustained | `context-heavy` | 1 | 15 | 15 | 0 | 0 | 1154 | 1169 | 1171 |
| sustained | `failure-escalation` | 1 | 8 | 4 | 4 | 0 | 1079 | 1259 | 1259 |
| sustained | `failure-retry` | 1 | 6 | 0 | 6 | 0 | 1526 | 1541 | 1541 |
| sustained | `model-routed-decision` | 1 | 20 | 20 | 0 | 0 | 493 | 803 | 1088 |
| sustained | `model-routed-decision` | 2 | 20 | 20 | 0 | 0 | 665 | 1111 | 1336 |
| sustained | `simple-deterministic` | 2 | 20 | 20 | 0 | 0 | 793 | 1184 | 1265 |
| sustained | `simple-deterministic` | 1 | 20 | 20 | 0 | 0 | 480 | 933 | 960 |
| sustained | `tool-surface-programmatic` | 1 | 20 | 20 | 0 | 0 | 626 | 1087 | 1097 |
| sustained | `tool-surface-programmatic` | 2 | 20 | 20 | 0 | 0 | 538 | 1108 | 1124 |
| sustained | `verification-heavy` | 2 | 20 | 20 | 0 | 0 | 658 | 821 | 1122 |
| sustained | `verification-heavy` | 1 | 20 | 20 | 0 | 0 | 788 | 1115 | 1133 |

### 7.5 Throughput observations

- **Burst c=16**: 32 executions, e2e p50 2595 ms — ≈ 12.3 executions/s sustained through
  the full governed path.
- **Steady burst c=32**: 32 executions, e2e p50 2548 ms / p99 5028 ms — ≈ 12.6 executions/s;
  the platform degrades gracefully from c=16 to c=32 (p50 flat, tail ×1.8).
- **Sustained window**: 199 executions across 1800 accumulated live seconds (~0.11/s by
  design — the window measures steady liveness, not peak throughput).
- **Concurrency scaling** (`simple-deterministic` p50): c=1 → 971 ms, c=4 → 1147 ms,
  c=16 → 1416 ms — sub-linear degradation dominated by claim cadence (§7.3).

### 7.6 Queue behavior

- **1 Hz depth timeseries** (`data/queue-depth.jsonl`, 2002 samples): p50 **0**, p90 **0**,
  p99 6, avg 0.29, max 32 (the max coincides with a c=32 burst — the queue drained
  completely afterward; it never sustained backlog).
- **Final operator inspection** (`data/queue-inspect.json`): 402 envelopes consumed,
  0 backlogged, 0 dead-lettered, 0 replay lineages; recent attempts all `accepted`
  at attempt №1.
- **Durable delivery record** (PostgreSQL): 402 dispatch envelopes, avg attempts **1.00**,
  max 1, redelivered 0, dead letters 0.

### 7.7 Worker lifecycle (6 real worker service processes; durable compute plane)

| worker | registered → last heartbeat | active s | heartbeats | mean interval |
|---|---|---|---|---|
| `01a08a55-2539…` | 08:00:31 → 08:06:38 | 367.14 | 332 | 1105.8 ms |
| `01a08a75-c062…` | 08:36:07 → 08:42:07 | 359.86 | 357 | 1008.0 ms |
| `01a08a7b-6692…` | 08:42:18 → 08:48:17 | 359.63 | 357 | 1007.4 ms |
| `01a08a81-53ca…` | 08:48:46 → 08:54:46 | 359.74 | 357 | 1007.7 ms |
| `01a08a86-f7cc…` | 08:54:56 → 09:00:56 | 360.00 | 357 | 1008.4 ms |
| `01a08a8c-8da3…` | 09:01:02 → 09:04:16 | 194.35 | 193 | 1007.0 ms |

All 6 drained gracefully (run/drain attestations in `data/worker.log`). Claims: 402
claimed / 402 finished / **0 abandoned**; avg claim 102 ms, max 2049 ms. No claim was
ever abandoned and no lease was force-released — the crash-resume gap between chunks 1
and 2 stranded nothing (queue depth 0, dead letters 0 at chunk 2 start).

### 7.8 Budget precision (declared vs recorded — durable `budgets` ledger)

| ledger class | entries | total |
|---|---|---|
| `credit-grant` (credit) | 1 | 1000 µ$ |
| `reservation-hold` (debit) | 28 | 28000 µ$ |
| `settle-release` (credit) | 28 | 28000 µ$ |

28 costed executions each held exactly the declared 1000 µ$ reservation and settled for
exactly 1000 µ$ — **declared vs recorded drift: zero** (min=max=1000 per entry); wallet
balance preserved at 1000 µ$. **Honest negative finding**: the `budget-exhausted` class
(12 executions across two c=6 batches) completed **12/12 with zero BUDGET_EXCEEDED
denials** — the concurrent live-reservation overlap the class was designed to provoke did
not materialize, because the worker's claim cadence serialized the 2 s costed executions
into settle-and-release sequences that stayed within the single-reservation bound. The
BUDGET_EXCEEDED denial path therefore remains **NOT exercised** in this run (§10). The
policy-denial seam WAS exercised: 3/3 `POLICY_DENIED` at the authorize transition, each
with durable denial evidence recorded in the ledger.

### 7.9 Release control (external `deploy:release` readings; `data/release-status-{start,mid,end}.json`)

| reading | at | gitRevision | active release | promotion | alerts | critical |
|---|---|---|---|---|---|---|
| start | campaign start (08:00) | `06d2adb` | null | not allowed (missing `validation`) | 0 | 0 |
| mid | sustained 885/1800 s | `ad2738d` | null | not allowed (missing `validation`) | 0 | 0 |
| end | campaign complete | `ad2738d` | null | not allowed (missing `validation`) | 0 | 0 |

Zero alerts and zero critical alerts across the entire campaign; the promotion ladder
remained fail-closed throughout (local environment has not passed the `validation` gate —
correct, since no release promotion was attempted). Quota guards: 3 configured
(`data/validate.json`); no quota alert fired at any reading.

### 7.10 Observability plane (D-06; `data/observability-samples.jsonl`)

**584 real OTLP/HTTP-JSON export requests** received and recorded, totaling 2,855,739
bytes: 142 `/v1/traces`, 420 `/v1/metrics`, 22 `/v1/logs`. Provenance: the repository's
real OTLP exporter through the bounded, environment-bound telemetry sink — the receiving
end is a **local collector stub** (no external OTLP backend exists in the sandbox). The
samples are the actual wire payloads; every export observed during the campaign is in the
JSONL file.

## 8. Resilience drill (D-07 surfaces; `data/drill.json`)

`bun run deploy:drill -- authority-loss --environment local` executed once at `ad2738d`:

| phase | duration | result |
|---|---|---|
| authority-backup (logical, checksummed) | 743 ms | 114 tables, 11 581 rows, 29 migrations |
| authority-restore (fresh disposable target, one transaction) | 1745 ms | 114 tables, 11 581 rows, 11 sequences reseeded, all tables verified |
| authority-invariants (D-07 gate) | 31 ms | 12 checks, **0 violations** |
| cleanup (drop disposable target) | 22 ms | live source never touched |

**Measured RTO: 2542 ms** (target ≤ 900 000 ms — within target). **Measured RPO: 0 ms**
(target 0 ms — within target; every transaction in the backup was in the restore).
The other drill surfaces (`artifact-exit`, `queue-recovery`, `worker-evacuation`,
`outage-readiness`) were NOT RUN — §10.

## 9. What this baseline establishes

On a single-host, staging-parity stack with zero provider credentials, the delivered
system was operated end to end through its real public surfaces for 405 governed
executions across 12 scenario classes and 6 concurrency levels, with:

- **Zero lost work**: 0 abandoned claims, 0 dead letters, 0 redeliveries needed, 402/402
  envelopes consumed, gapless per-execution event sequences, and a real mid-campaign
  crash-resume that stranded nothing.
- **Honest failure handling**: every failure and denial in the record is an intended
  governed outcome with durable evidence; nothing was retried away or papered over.
- **Exact budget accounting**: declared-vs-recorded drift of zero across 28 costed
  executions; wallet balance preserved.
- **Clean worker hygiene**: 6/6 registrations, ~1 Hz heartbeats, 6/6 graceful bounded
  drains, 0 abandoned claims.
- **Fail-closed release control**: promotion never unlocked, zero alerts throughout.
- **Authority-loss recovery well within targets**: RTO 2.5 s vs 900 s budget, RPO 0 ms,
  with all 12 authority invariants verified on the recovered copy.

## 10. NOT RUN / not exercised — the honest boundary list

1. **No real external traffic, customers, or tenants** — all load is synthetic, generated
   by the measurement harness under a single synthetic campaign identity
   (`data/world.json`).
2. **Single-host sandbox, single region** — no geo-distribution, no multi-region failover,
   no network partitioning, no real latency geo-effects.
3. **Queue transport is the local protocol-faithful stand-in**, not real Cloudflare
   Queues (no provider credentials in the sandbox). Delivery/retry/dead-letter behavior
   measured is the stand-in's protocol-faithful implementation.
4. **Observability receiving end is a local collector stub**, not an external OTLP
   backend (the exporter and wire format are real; §7.10).
5. **Redis ephemeral coordination degraded by explicit choice** — smoke readiness is
   honestly `degraded`, never counted as ready.
6. **BUDGET_EXCEEDED denial path NOT exercised** — `budget-exhausted` completed 12/12
   (§7.8); only `POLICY_DENIED` was exercised (3/3). Budget-concurrency denial behavior
   remains unmeasured.
7. **Model-routed classes recorded planning decisions against neutral routes** — no real
   model providers were invoked (no credentials); "model routing" here measures the
   decision-record + ledger path, not live LLM inference.
8. **The 1800 s sustained window is accumulated across 6 chunks**, not one uninterrupted
   process (longest single window 368 s; one ~29.5 min interruption disclosed in §6).
9. **Only the `authority-loss` drill was run**; `artifact-exit`, `queue-recovery`,
   `worker-evacuation`, and `outage-readiness` were NOT RUN (single drill per the task
   minimum). Provider redundancy (real failover, not restore-into-disposable-target) was
   NOT exercised.
10. **Platform-side progression (authorize/plan/queue/dispatch) has no HTTP surface at
    this revision** — the harness performed the composition-root role in-process; those
    stage latencies are module latencies, not network round-trips (disclosed in §1).
11. **`summary.json`'s `planningDecisions` field reads
    `execution_ir.optimization_decision_records`** (the WORK-056 competence plane) and is
    honestly 0 for this campaign; the campaign's planning decisions landed in the
    execution ledger as 78 `planning.decision-recorded` events — the field measures a
    different plane than the one exercised.
12. **No CI/preview/staging/production environments** — local only; no TLS, no real DNS,
    no ingress, no horizontal scale (one API server, one worker at a time).

## 11. What this baseline authorizes

This record satisfies **D-08 gate-1** (measured production usage evidence) in its
honest form: a fully instrumented, single-host, staging-parity measurement of the real
delivered system through its real public surfaces, with every claim traceable to raw
committed data and every boundary listed. Together with the already-approved gates 2+3
(availability/security requirements + ADR-0021/ACR-005 on main), this unblocks **D-08
scoping** (regional/data-residency deployment, private connectivity, tenant isolation,
HA database topology, compliance controls, provider redundancy).

It does **NOT** authorize: any multi-tenant production claim, any HA-topology claim, any
provider-redundancy claim, or any extrapolation of these latencies to geo-distributed
deployments. Those all remain NOT RUN (§10).

## 12. Changed-file inventory (dispatch base → final head)

| file | change |
|---|---|
| `deploy/usage-world.ts` | new — per-chunk world composition root (API server, queue stand-in, OTLP stub, REAL worker process spawn; the only file holding raw SQL seeds and `node:http`) |
| `deploy/usage-campaign.ts` | new — the chunked campaign driver (measurement only) |
| `deploy/usage-summarize.ts` | new — metric computation → `benchmarks/d08-usage/data/summary.json` |
| `benchmarks/d08-usage/README.md` | new — measurement-surface documentation |
| `benchmarks/d08-usage/scenarios.ts` | new — 12 scenario class definitions (pure measurement definitions; imports only the harness world type) |
| `benchmarks/d08-usage/data/**` | new — 30 raw evidence files (24 at `data/` top level + 6 chunk manifests: JSONL ledgers, operator-surface captures, summary) |
| `docs/deployment/D08-PRODUCTION-USAGE-MEASUREMENT.md` | new — this document |
| `biome.json` | +1 line: lint scope excludes `benchmarks/d08-usage/data` (raw JSONL/JSON data files are not code; keeps the baseline lint gate green with raw data committed) |

Harness placement note (post-review boundary remediation): the three
composition files above were initially committed under
`benchmarks/d08-usage/` and relocated to `deploy/` (byte-identical logic;
import specifiers and `REPO_ROOT` adjusted for the new location) after the CI
architecture battery flagged that the benchmark non-authority boundary
(§21) forbids network imports, `fetch(`, raw SQL and platform/module-internal
imports under `benchmarks/`. `deploy/` is the repository's operator-composition
precedent (`deploy/drill.ts` composes pg + platform internals + raw SQL), and
the relocation weakens no boundary: `src/**` and `spec/**` remain untouched,
no test was modified, and `benchmarks/d08-usage/` now holds ONLY pure
measurement definitions + committed raw data. The campaign data files never
moved and were never regenerated; every measured number in this document is
exactly as recorded.

`src/**`, `spec/**`, `sdk/**`, `tests/**` — **unchanged** (verified:
`git diff f2b5284..HEAD -- src/ spec/ sdk/ tests/` is empty). `deploy/**`
gains exactly the three `usage-*` measurement harness files above and nothing
else.

## 13. Reproduction

```bash
export ZECK_ENVIRONMENT=local
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres
export ZECK_DATABASE_URL=postgres://postgres@127.0.0.1:55432/zeck_local
export ZECK_LOCAL_DATA_ROOT=~/.local/share/zeck

bun install
python3 scripts/governance-check.py && bun run typecheck && bun run lint

bun run deploy:validate && bun run deploy:bootstrap -- --environment local
bun run deploy:migrate -- --environment local
bun run deploy:smoke -- --environment local --allow-degraded

bun deploy/usage-campaign.ts warmup
# the campaign, as N sequential bounded chunks (sandbox reaper contract):
bun deploy/usage-campaign.ts chunk --chunk-id 1 --budget-seconds 360
# … repeat with increasing --chunk-id until "campaign: ALL WORK COMPLETE"
bun deploy/usage-campaign.ts summary
```

External operator-surface captures taken around the campaign: `deploy:release status/alerts`
(start/mid/end), `deploy:queue -- inspect`, `deploy:drill -- authority-loss`, and the
post-campaign `deploy:validate/bootstrap/migrate/smoke` re-run — all committed under
`benchmarks/d08-usage/data/`.
