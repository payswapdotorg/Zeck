# D-07 operator runbooks — resilience, disaster recovery and provider exit

These runbooks are the repository-defined recovery procedures for
WORK-048 / Deployment Roadmap D-07. Every procedure:

- **restores** authoritative state from PostgreSQL-defined artifacts —
  it never *reconstructs* authority from provider dashboards or
  provider-local state;
- runs with repository tools (`bun run deploy:drill <command>`) over
  provider-neutral ports — an entirely self-hosted stack runs the same
  code with its own endpoints;
- records measured RTO/RPO evidence against the repository targets
  (`deploy/manifests/recovery-targets.json`) — never aspirational
  prose, never an unexecuted claim.

## The drill surface

| Scenario | Command | Runbook |
| --- | --- | --- |
| Authority loss (PostgreSQL) | `bun run deploy:drill authority-loss --env <env>` | [d07-authority-loss.md](d07-authority-loss.md) |
| Artifact store exit (R2 → alternate S3-compatible) | `bun run deploy:drill artifact-exit --env <env>` | [d07-artifact-exit.md](d07-artifact-exit.md) |
| Queue/workflow loss (transport replay) | `bun run deploy:drill queue-recovery --env <env>` | [d07-queue-recovery.md](d07-queue-recovery.md) |
| Regional worker loss (evacuation/drain/fence) | `bun run deploy:drill worker-evacuation --env <env> --region <label> --mode drain\|fence` | [d07-worker-evacuation.md](d07-worker-evacuation.md) |
| Outage readiness (targets gate) | `bun run deploy:drill outage-readiness --env <env>` | [d07-outage-readiness.md](d07-outage-readiness.md) |

## Honesty rules

- A provider half that is not configured is reported **NOT RUN** —
  never claimed as PASS.
- A verification that fails marks the whole drill **not recovered**
  (exit code 1); there is no partial credit.
- Objectives (`rtoWithinTarget` / `rpoWithinTarget`) are measured from
  the drill clock and compared against the environment's repository
  target; breaches exit non-zero.
- Secrets are environment-materialized only (see
  `deploy/manifests/variables.json`); nothing credential-shaped is
  ever committed.

## Provider substitution summary (D1.0 §"provider exit")

| Critical provider category | Exit path | Substitute |
| --- | --- | --- |
| Artifact storage | `artifact-exit` drill | any S3-compatible endpoint + credentials (content-addressed keys are digest-derived, not provider-derived) |
| Managed PostgreSQL | `authority-loss` restore drill | any managed/self-hosted PostgreSQL 16+ (deterministic migrations + logical-backup restore) |
| Web/API hosting | deployment-level | any host running the repository server image (no provider-specific domain semantics; see `docs/DEPLOYMENT-ARCHITECTURE.md`) |
