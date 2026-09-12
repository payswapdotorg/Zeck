# Long-Running / Resumable Agent Application (VAL-013)

A customer-style long-running agent application: batch jobs whose
executions span durable checkpoints, external interruptions, resumes,
and recovery discrimination, submitted through Zeck's public SDK
boundary.

## What it does

Submits one pinned `long-running.checkpoint-resume.v1` corpus task
(`kind: "long-run"` with the job and interruption directive), awaits
asynchronous completion through the platform's checkpointed path
(durable checkpoints with digests after every committed item, REAL
wait-user/resume cycles on the execution state machine, exactly-once
effects across interruptions, corrupted-checkpoint detection, the
stale-worker resume denial, and the no-op resume replay after
terminal), retrieves the result package and asserts the per-row
deterministic outcome contract: healthy runs COMPLETED+PASS; the
corrupted-checkpoint edge FAILS honestly.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Each batch item's effect applies exactly once (idempotent resume).
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-013-long-running.test.ts`).
