# PPR-018 Demo Mirror entry (DATA ONLY — NOT ACTIVATED)

`demo-entry.json` is the Demo Mirror registration data for the Aider
compatibility proof, prepared per PPR-018's website-demonstration
requirement ("Register Aider in the Demo Mirror only with the evidence
status the compatibility framework produces — the demo must run the
actual pinned Aider integration or its exact application runtime").

**Not activated by this worker.** The Demo Mirror's record source
(`apps/dashboard/demo-mirror.ts`) currently resolves the PPR-017 fixture
records; extending the source with file-based live evidence records is
the Lead's merge-time wiring (the PPR-017 delivery recorded the
sibling-consumer extension point). Surface ownership forbids this worker
from touching `apps/dashboard/**`.

When the Lead binds it:

- the entry binds evidence record `ppr-018-aider-live-proof`
  (`deploy/evidence/ppr-018.json`) — the status is DERIVED from that
  record by the strict ACR-006 admission evaluation on every render, and
  the run control stays unavailable unless the derived status is
  AI_EXECUTION_COMPLETE;
- a run replays the pinned Aider runtime through the exact certified
  integration path (`compat/aider/harness/run-battery.ts` — real pinned
  Aider, real Zeck executions, real corpus outcomes, never a synthetic
  coding response);
- the demo exposes the real task result (the corpus check output) and
  the Zeck execution trace (lifecycle events, route facts, verification
  results, usage) for every delegated edge.
