# D-08 gate-evidence measurement harness

The measured-production-usage campaign definitions and raw data for the
D-08 gate (dispatch: `gate/d08-measured-usage`). MEASUREMENT ONLY — the
harness never mutates authority outside the governed paths and never claims
a plane it does not exercise (see
`docs/deployment/D08-PRODUCTION-USAGE-MEASUREMENT.md` for the evidence
document this feeds).

This directory holds the PURE MEASUREMENT surfaces only (scenario
definitions + committed raw data). The campaign composition root lives in
`deploy/` — the repository's operator-composition precedent, where the
`usage-*` harness files may compose the platform internals, the SQL
authorities and the network the same way `deploy/drill.ts` does (the
benchmark non-authority boundary, deployment security boundary §21,
forbids network/SQL/platform/internal access under `benchmarks/`):
`deploy/usage-world.ts` (per-chunk world composition),
`deploy/usage-campaign.ts` (the chunked campaign driver) and
`deploy/usage-summarize.ts` (the metric summary pass).

## What it composes (all REAL, repository-defined surfaces)

| Plane | Composition |
|---|---|
| Authority | PostgreSQL `zeck_local` (D-02 converged local database) via `PgDatabasePort` |
| Public surface | `createApiServer` (Fastify) over the real SQL module authorities, listening on `127.0.0.1:4100` — driven with the real `sdk/index.ts` `ZeckClient` |
| Queue | the REAL Cloudflare-Queues adapter pointed at the local protocol-faithful stand-in from `tests/integration/queue/lib/fake-cloudflare-queues.ts` (no provider credentials exist in the sandbox — recorded honestly) |
| Execution | the REAL worker service process `bun deploy/worker.ts run --environment local --application-id …` (own OS process, SIGTERM → bounded graceful drain) |
| Dispatch | the REAL `DurableDispatcher` over `QueueCorrelationStore` (PostgreSQL) |
| Observability | the REAL OTLP/HTTP-JSON exporter through the bounded, environment-bound telemetry sink → a local collector stub recording every export |
| Release control | `bun deploy/release.ts status/alerts` captured externally at start/mid/end |

## Usage

```bash
export ZECK_ENVIRONMENT=local
export ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres
export ZECK_DATABASE_URL=postgres://postgres@127.0.0.1:55432/zeck_local
export ZECK_LOCAL_DATA_ROOT=~/.local/share/zeck

bun run deploy:validate && bun run deploy:bootstrap -- --environment local
bun run deploy:migrate -- --environment local
bun run deploy:smoke   -- --environment local --allow-degraded

bun deploy/usage-campaign.ts warmup     # 3-execution end-to-end sanity run
bun deploy/usage-campaign.ts chunk --chunk-id 1 --budget-seconds 360  # one bounded chunk (repeat with increasing ids)
bun deploy/usage-campaign.ts summary    # metric tables → data/summary.json
```

## Scenario classes (12)

`simple-deterministic`, `model-routed-decision`, `tool-surface-programmatic`,
`context-heavy`, `failure-retry`, `failure-escalation`, `competence-reuse`,
`budget-funded`, `budget-exhausted`, `policy-denied`, `verification-heavy`,
`burst-load` — definitions and honest plane mappings in `scenarios.ts`.

## Data files (all under `data/`, committed as raw evidence)

| File | Content |
|---|---|
| `world.json` | the campaign identity (tenant/app/environment/actor) |
| `executions.jsonl` | one record per governed execution (outcome, stage latencies from the durable ledger, failure classification) |
| `queue-depth.jsonl` | 1 Hz backlog samples from the queue stand-in |
| `observability-samples.jsonl` | every OTLP export request received by the collector stub |
| `worker.log` | the worker process stdout (registration + graceful drain attestations) |
| `campaign-progress.json` | live progress marker (updated per phase/tick) |
| `summary.json` | the computed metric tables + durable-state reads |
| `release-status-{start,mid,end}.json` | external `deploy:release` readings |
| `queue-inspect.json`, `drill.json`, `smoke.json`, `identity.json` | external operator-surface outputs |
