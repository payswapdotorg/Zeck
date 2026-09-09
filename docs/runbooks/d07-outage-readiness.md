# D-07 runbook — outage readiness (the recovery-targets gate)

**Scenario:** the periodic readiness gate — verify that the
environment's recovery objectives are repository truth (bounded,
numeric, measured by a declared procedure) and that the drill
machinery is wired and valid. This is the configuration gate; RTO/RPO
are MEASURED by the loss scenarios, not by this command.

**Tool:** `bun run deploy:drill outage-readiness --env <environment>`

## The procedure (what the tool runs)

1. **Recovery targets** — the repository document
   (`deploy/manifests/recovery-targets.json`) loads with the
   environment's target: bounded numeric `rtoTargetMs`/`rpoTargetMs`,
   a scope, and a measurement procedure. Provider dashboards, chat or
   incident notes cannot redefine a target.
2. **Drill surface** — the deployment configuration validation passes
   (including the D-07 rule: every environment class of the
   environments.json matrix has a recovery target — an environment
   without recovery objectives is unrepresentable).

## Success criteria

- Both phases `ok: true` (exit 0). This command measures NO objectives
  (its `objectives.measured: false` is the honest record: readiness,
  not recovery).

## Failure handling (fail-closed)

- "no recovery target defined for environment" — add the environment's
  target to `deploy/manifests/recovery-targets.json` (bounded numbers
  + measurement procedure) and re-run `bun run deploy:validate`.
- Deployment-validation failures — fix the reported problems; the
  drill surface must be valid before any loss drill runs.

## What outage simulation proves (and where)

The fail-closed behavior for each provider class is simulated and
verified by the test suites (a live outage is never needed to prove
the DESIGN, and unexecuted live-provider results are never claimed):

- queue transport outage → typed transient transport failures; the
  bounded publish budget backlogs; republish converges after the
  outage (`recovery-transport-replay.test.ts` R2);
- object-store outage → the adapter's typed 5xx error, never a silent
  null/success (`recovery-artifact-exit.test.ts` A2);
- database outage → the authority-unavailable class; every
  authority-bearing operation refuses, nothing promotes; a drill hit
  by the outage is a failed drill (`recovery-outage.test.ts`).
