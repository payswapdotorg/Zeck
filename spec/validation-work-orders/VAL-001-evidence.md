# VAL-001 — Evidence Document (Validation Lab Bootstrap and Governance)

**Work order:** `spec/validation-work-orders/VAL-001.md`
**Authorization:** GitHub issue #41
**Assurance:** HIGH_ASSURANCE
**Dispatch base:** `90ceeddd1c6e5553254eaaade3155be391670787` (governed validation head at dispatch; CI green at base: Repository Governance, Deployment Validation, Deployment Release Control)
**Implementation head:** recorded in the PR head of `work/VAL-001-validation-lab-bootstrap`
**Mode:** Tech Lead direct implementation (chat.z.ai worker channel unavailable — account server-side blocked, unblock 2026-09-18 18:37 UTC; operator-directed pivot, recorded in the resident worklog)

## Changed-file inventory (14 files)

- `benchmarks/validation/program.ts` — deterministic program entrypoint (AC1): identity, canonical document pointers, stages, three-worker ceiling, `resolveProgramEntrypoint`.
- `benchmarks/validation/state.ts` — validation-state consistency contract (AC2): `checkValidationStateConsistency` over the three governed state files (program/frontier/dependency agreement, ceiling, dependency completeness, cycles, eligible/in-flight rules).
- `benchmarks/validation/run-identity.ts` — run identity (AC4): `deriveRunId` (deterministic SHA-256 over the canonical reproduction configuration; timestamp excluded) + `checkRunMetadata` (reproduction-complete metadata admission).
- `benchmarks/validation/submission.ts` — worker submission/evidence contract (AC3): `SubmissionRecord` with exact base/final head (full SHAs), changed files, battery, the seven-part issue solution protocol, NOT RUN boundaries, evidence refs; `validateSubmission` rejects weakened submissions.
- `benchmarks/validation/report.ts` — cumulative report projection (AC5): five-section separation (observed facts / failures / hypotheses / recommendations / NOT RUN), provenance on every entry, hypotheses never derived from battery output, NOT RUN never converts to a pass.
- `benchmarks/validation/surfaces.ts` — surface-ownership governance (AC6): `parseAllowedSurfaces` (mechanical spec parsing) + `surfaceOwnershipConflicts` (same-surface and wildcard-cover conflicts rejected; disjoint additive directories allowed).
- `benchmarks/validation/index.ts` — public barrel.
- `benchmarks/validation/README.md` — self-contained Tech Lead documentation (AC8): dispatch loop, battery, run identity, boundaries.
- `scripts/validation-check.py` — standalone deterministic governance checker (CI parity via the vitest mirror).
- `tests/unit/validation/validation-state-consistency.test.ts` — AC2 against the REAL state files + discrimination (corrupted ceiling, incomplete dependency, dependency cycle).
- `tests/unit/validation/submission-and-run-identity.test.ts` — AC3/AC4 contracts + discrimination (no evidence refs, short SHA, empty protocol parts, empty battery/inventory, reasonless NOT RUN, incomplete metadata, identity determinism/sensitivity).
- `tests/unit/validation/entrypoint-surfaces-authority.test.ts` — AC1/AC6/AC7: entrypoint determinism + canonical files exist; real in-flight set conflict-free; parser reads real specs; same-surface and wildcard-cover conflicts rejected (discrimination); disjoint additive directories allowed; one validation-state authority; no product-internals/platform/internal imports; no network/SQL/mutation channel in the lab.
- `tests/unit/validation/report-structure.test.ts` — AC5: projection separation, facts+failures duality, provenance, NOT RUN never a pass (discrimination), explicit hypotheses; the maintained document carries the five sections.
- `docs/VALIDATION-REPORT.md` — extended with the five mandated separation sections (Observed facts / Failures and root causes / Hypotheses (open) / Recommendations / NOT RUN boundaries) + reproducibility pointers to the lab and state authority.

## Acceptance-criteria mapping

| AC | Evidence |
|---|---|
| 1. Deterministic entrypoint → roadmap/contract/state | `program.ts` + `entrypoint-surfaces-authority.test.ts` (determinism + canonical files exist) |
| 2. State records dependencies/frontier/in-flight/ceiling | `spec/validation-state/*` (governed) + `state.ts` + `validation-state-consistency.test.ts` + `scripts/validation-check.py` |
| 3. Standard submission/evidence structure | `submission.ts` + `submission-and-run-identity.test.ts` |
| 4. Stable run ids + reproduction metadata | `run-identity.ts` + identity tests (determinism, timestamp exclusion, sensitivity) |
| 5. Cumulative report five-way separation | `report.ts` + `report-structure.test.ts` + the updated `docs/VALIDATION-REPORT.md` |
| 6. Governance rejects same-surface simultaneous ownership | `surfaces.ts` + conflict discrimination tests + real in-flight check |
| 7. No duplicated product/development authority | authority-isolation tests (one state authority; no internals/platform imports; no network/SQL/mutation) |
| 8. Self-contained fresh-Tech-Lead documentation | `benchmarks/validation/README.md` |

## Executed battery (at the implementation head, sequential per OOM discipline)

| Command | Outcome | Detail |
|---|---|---|
| `python3 scripts/governance-check.py` | pass | `Governance OK: 60 Work Orders, 110 requirements, inFlight=[], frontier=[]` (product program untouched) |
| `python3 scripts/validation-check.py` | pass | `Validation OK: 46 validation work orders, inFlight=[VAL-001], eligible=[none]` |
| `bun run typecheck` | pass | 0 errors (tsc strict, noUncheckedIndexedAccess) |
| `bun run lint` | pass | exit 0; warnings-only (pre-existing baseline); new files 0 diagnostics |
| `bun run test:unit` | pass | 235 files / 3416 tests (baseline 231/3381 at e00745f + 4 files / 35 new validation tests) |
| `bun run test:architecture` | pass | 106 files / 1423 tests (boundary suite polices `benchmarks/validation/**` — compliant) |
| `ZECK_PG_TEST_URL=postgres://zeck@127.0.0.1:55432/postgres bun run test:integration` | pass | 121 files / 1123 tests against real PostgreSQL 16.4 (20 skipped: HA suite by design); one first-run flake (`long-running-lifecycle`) passed in isolation and on the full rerun — documented parallel-load port-contention pattern, not a code defect |
| Fresh-clone bootstrap proof | see below | validation-check + validation tests green from a fresh clone |

## Fresh-clone bootstrap proof

A fresh clone of the branch, `bun install`, `python3 scripts/validation-check.py`
and `bunx vitest run tests/unit/validation` — all green (recorded in the PR
conversation at review time with exact output).

## Issue findings and protocol

- **Flake (classification: test-harness/infrastructure, not a defect).**
  Reproduction: `test:integration` full-battery first run failed
  `long-running-lifecycle.test.ts` (1 test); isolation rerun and full-battery
  rerun both green. Impact: none on acceptance criteria (VAL-001 changes no
  product code; the flake is the documented parallel-load pattern).
  Root cause: shared-resource contention under the full parallel battery
  (prior program documented the same pattern). Viable solutions: rerun
  (chosen), sequential mode, test quarantine. Recommended: rerun +
  documentation (mechanical, zero semantic risk). Verification: green
  reruns recorded above.
- **chat.z.ai worker channel unavailable (classification: external
  limitation, surfaced to operator).** Reproduction: `/api/v1/chats/list`
  returns `403 USER_BLOCKED` with unblock `2026-09-18T18:37:04Z`. Impact:
  worker dispatch impossible; this work order was implemented directly by
  the Tech Lead at the integration station. Root cause: account-level
  server-side block. Viable solutions: wait for unblock, second operator
  account, direct Tech Lead implementation. Recommended: direct
  implementation for lab foundations (deterministic, contract-shaped
  work) with worker dispatch resuming when the channel returns.
  Verification: this battery + PR review + CI.

## NOT RUN boundaries

- No chat.z.ai worker dispatch for this work order (external limitation,
  recorded above; does not affect the acceptance criteria — the work
  order's contract was implemented and evidenced at the integration
  station).
- No provider/model runs (none are in VAL-001 scope; the provider
  capability matrix is VAL-009).

## Surface honesty

- Frozen v1.0 semantics: untouched (no `src/` changes at all).
- Product Work Order state (`spec/development-state/*`): untouched —
  governance-check passes with the identical product verdict.
- Credentials: none in source, tests, logs or this document.
- This PR does not merge itself.
