# D-07 runbook — queue/workflow loss (transport replay)

**Scenario:** the queue transport provider (or the workflow
orchestration provider) loses its messages/instances — total loss is
the design case. Queue messages are POINTERS; the durable dispatch
envelopes in PostgreSQL are the intent records; workflow instances are
provider mechanisms and the durable wait records are the
orchestration truth. Replay converges through the EXISTING
dispatch/execution idempotency — never provider-side dedup.

**Tool:** `bun run deploy:drill queue-recovery --env <environment> [--limit N]`

## Preconditions

- The environment's PostgreSQL URL is materialized (same as the
  authority-loss runbook).
- For the republish half (provider environments only): the queue
  transport configuration (`ZECK_QUEUE_ID`, `ZECK_QUEUE_API_TOKEN`)
  must be materialized; without it the republish half is an honest
  **NOT RUN** and the recovery PLAN half still executes.

## The procedure (what the tool runs)

1. **Recovery plan** — classify EVERY durable dispatch envelope from
   PostgreSQL (fail-closed on any state outside the closed
   vocabulary):
   - `recorded` / `backlogged` → **republish** (publication never
     accepted or the bounded publish budget was exhausted during the
     outage);
   - `published` (unapplied) → **re-drive** (the message may be lost;
     the executions authority re-drive converges it WITHOUT the
     queue: fresh claim, fresh lease epoch, idempotent start);
   - `consumed` → **converged** (the transport finished carrying it);
   - `dead-lettered` → **dead-lettered** (the bounded replay path).
2. **Bounded republish** (when configured) — the dispatcher's
   crash/outage recovery republishes recorded/backlogged envelopes
   through the REAL transport adapter, reading PostgreSQL only.

Convergence afterwards is the standard machinery: fresh workers
re-drive recoverable executions from the authority (no queue
involvement), with exactly one provider dispatch per execution and no
duplicate authoritative effects (the deterministic correlation keys
and the single execution write path are the idempotency).

## Success criteria

- The plan completes (`complete: true`) — every envelope classified.
- Republish outcomes published (or honestly NOT RUN).
- Objectives within the environment target (exit 0).

## Failure handling (fail-closed)

- "unknown state" — envelope state corruption: the planner refuses to
  guess; investigate the drift before any recovery action.
- The plan hit its bounded limit — raise `--limit` and re-run (the
  scan is bounded by design; unbounded recovery scans are
  unrepresentable).
- Local evidence is produced by the integration suite
  (`tests/integration/postgres/recovery-transport-replay.test.ts`,
  including the message-losing transport double and the replaced
  orchestration provider); live transport providers are exercised by
  running this drill with real credentials (NOT RUN until then).
