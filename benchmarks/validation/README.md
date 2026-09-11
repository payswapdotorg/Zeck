# Zeck Validation Laboratory (VAL-001)

The executable laboratory for the customer-style validation program
(`docs/VALIDATION-ROADMAP.md`). This directory is **evidence
infrastructure, never authority**: nothing here authorizes providers,
mutates product or development state, or substitutes for the governed
platform surfaces. The lab validates the finished system exactly the way
a customer consumes it — through the public SDK/API — and records what
happened.

## What lives here

| Surface | Contract |
|---|---|
| `program.ts` | The deterministic program entrypoint: identity, canonical governing documents, stages, the three-worker ceiling. |
| `state.ts` | Mechanical consistency rules for the governed validation state (`spec/validation-state/*`). |
| `run-identity.ts` | Stable run ids + the reproduction-complete run metadata contract. |
| `submission.ts` | The standard worker submission/evidence structure (exact base, final head, changed files, battery, seven-part issue protocol, NOT RUN boundaries). |
| `report.ts` | The cumulative report projection: observed facts, failures, hypotheses, recommendations, NOT RUN. |
| `surfaces.ts` | Surface-ownership governance: rejects simultaneous in-flight ownership of the same protected validation surface where reconciliation is non-mechanical. |
| `evidence/` | Validation evidence documents, one per work order (`VAL-NNN.md`) — kept out of `spec/` by convention (the product e11 containment proofs diff `spec/` against the branch merge-base). |
| `index.ts` | The public barrel. |

Everything is pure: no file access, no network, no database, no
authority mutation. The files are read and driven by tests
(`tests/unit/validation/`) and by the standalone governance checker.

## The governed state

`spec/validation-state/` is the ONE authority for validation program
state:

- `program-state.json` — every work order, its title and status;
- `frontier-state.json` — eligible / in-flight / blocked, ceiling 3;
- `dependency-state.json` — the dependency graph.

Check consistency (also enforced in CI through
`tests/unit/validation/`):

```bash
python3 scripts/validation-check.py
```

## Dispatching a validation worker (Tech Lead)

1. Recover state: read the roadmap, the Tech Lead contract and the three
   state files; run both governance checks (`governance-check.py` and
   `validation-check.py`).
2. Choose up to three conflict-safe work orders: parse each candidate
   spec's `## Allowed surfaces` block and require
   `surfaceOwnershipConflicts(inFlight)` to stay empty — simultaneous
   ownership of the same protected surface is rejected unless the
   overlap is additive new files in disjoint directories.
3. Dispatch at an exact base (current governed validation head) with the
   full delivery chain in the prompt: one branch
   `work/VAL-NNN-short-name`, the battery below, evidence doc, PR
   (never self-merged), CI poll, final report.
4. On delivery, verify the submission against
   `validateSubmission(...)` — a submission missing any mandated part is
   rejected — then re-run the battery locally at the reported head
   (never trust reported numbers), review, merge, and finalize state.

## The battery

```bash
bun install
bun run typecheck
bun run lint
bun run test:unit
bun run test:architecture
bun run test:integration   # with a real PostgreSQL via ZECK_PG_TEST_URL
python3 scripts/governance-check.py
python3 scripts/validation-check.py
```

`tests/unit/validation/` runs as part of `test:unit` in CI: the
validation contracts are gated with every PR.

## Run identity and evidence

Every validation run derives a stable id:

```ts
import { deriveRunId, checkRunMetadata } from "benchmarks/validation";

const metadata = {
  program: "zeck-validation",
  workOrder: "VAL-010",
  baseRevision: "<full 40-char SHA>",
  applicationRevision: "<app repo SHA>",
  corpusRevision: "<corpus SHA>",
  integrationSurface: "sdk",
  environment: { runtime: "bun", toolchain: "…", database: "…" },
  observedAt: new Date().toISOString(),
};
checkRunMetadata(metadata); // [] — complete, admissible evidence
const runId = deriveRunId(metadata); // deterministic SHA-256 identity
```

The id digests the reproduction configuration only (never the
timestamp), so re-running the same configuration yields the same
identity and any reproduction-relevant change yields a new one.

## Boundaries (honesty rules)

- `benchmarks/**` is policed by the architecture boundary tests: no
  network imports, no `fetch`, no raw SQL, no external-framework
  identifiers, imports only from public barrels. The validation lab is
  self-contained and satisfies all of them by construction.
- The lab never reads secrets; provider credentials live in the
  environment and never in the repository, logs or reports.
- NOT RUN boundaries stay NOT RUN: an unavailable provider run is
  recorded with its exact reason and surfaced to the operator — never
  converted into a pass.
