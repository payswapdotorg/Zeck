# PPR-018 Demo Mirror entry (BOUND at the deployment seam)

`demo-entry.json` is the Demo Mirror registration data for the Aider
compatibility proof, prepared per PPR-018's website-demonstration
requirement ("Register Aider in the Demo Mirror only with the evidence
status the compatibility framework produces — the demo must run the
actual pinned Aider integration or its exact application runtime").

**Bound by PPR-028A (Worker A).** The original data-only delivery
reserved the activation for the Lead's merge-time wiring; the PPR-028
closure work order (Section B — "Repair Aider's missing Demo Mirror
binding") authorizes exactly that act:

- the entry binds evidence record `ppr-018-aider-live-proof`
  (`deploy/evidence/ppr-018.json`) — the status is DERIVED from that
  record by the strict ACR-006 admission evaluation on every render, and
  the run control stays unavailable unless the derived status is
  AI_EXECUTION_COMPLETE;
- a run replays the pinned Aider runtime through the exact certified
  integration path (`compat/aider/runtime/aider-pinned-driver.ts` over
  the same proof pieces `compat/aider/harness/run-battery.ts` composes
  — real pinned Aider, real Zeck executions, real corpus outcomes,
  never a synthetic coding response);
- the driver verifies the pinned venv's exact revision (`aider
  --version` carrying the `+g5dc9490bb` exact-commit build tag) before
  every run and refuses honestly (a named NOT-RUN with owner) when the
  runtime is absent or revision-mismatched;
- the demo exposes the real task result (the corpus check output) and
  the Zeck execution trace (lifecycle events, route facts,
  verification results, usage) for every delegated edge;
- final certification is the Tech Lead's gate (the record's
  `finalCertification` field); the worker recommends, never certifies.
