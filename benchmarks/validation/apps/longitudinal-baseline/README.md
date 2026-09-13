# Longitudinal-Baseline Application (VAL-030)

A customer-style control-run application: one pinned frozen-baseline
corpus row per run, submitted through Zeck's public SDK boundary with
the CONTROL arm declaration (learning explicitly `inert`) riding the
task semantics. This is the baseline-freeze slice that opens the
longitudinal learning wave: what learning will be measured AGAINST is
frozen BEFORE any learning happens — every later learning claim must
beat this reference arm.

Per row, the corpus declares the content-addressed baseline manifest
entry (the app digest over the frozen application-portfolio artifact +
the golden workload-corpus revision digest — digests over the pinned
artifacts, never the artifacts copied), the expected terminal and the
trajectory-digest equivalence class the control run must reproduce.
The freeze is mechanically trustworthy: re-run equivalence (a control
re-run over the deterministic fixtures reproduces the recorded
trajectory-digest class), ledger exactly-once (one immutable
longitudinal-experiment identity per control run, per the VAL-007
discipline) and freeze integrity (any mutation of a frozen app
version, workload revision or recorded trajectory FAILS the digest
check — a drifting baseline is unrepresentable).

## The pinned corpus (`longitudinal-baseline.control.v1`)

| Row | Frozen app | Golden workload | Expected terminal | Trajectory class | Pins |
|---|---|---|---|---|---|
| text-summarize-baseline | portfolio:text-generation v1 | golden:text-summarize-digests r1 (1 round, 1 effect, quota 5_000 ≥ 1_500) | COMPLETED | 1 member | the canonical control trajectory |
| rag-retrieval-corrected-baseline | portfolio:rag v1 | golden:rag-retrieval r2 (2 rounds, 2 effects, quota 6_000 ≥ 3_000) | COMPLETED | 1 member | the CORRECTED revision — r1 committed then superseded; the registry history holds BOTH (append-only) |
| tool-agent-loop-baseline | portfolio:tool-agent v1 | golden:tool-agent-loop r1 (3 rounds, 1 effect, quota 4_000 ≥ 900) | COMPLETED | 1 member | three fresh dispatches — the inert-learning floor |
| coding-fix-baseline | portfolio:coding v1 | golden:coding-fix r1 (2 rounds, 1 effect, quota 8_000 ≥ 3_000) | COMPLETED | 1 member | diagnose-then-patch control shape |
| order-settlement-equivalence-class | portfolio:operations v1 | golden:order-settlement r1 (1 round, 2 INDEPENDENT effects, quota 3_000 ≥ 0) | COMPLETED | **2 members** | either equivalent notification ordering is honest reproduction — the class, not one byte-sequence, is the frozen oracle |
| oversized-batch-guard-rejected | portfolio:operations v1 | golden:oversized-batch r1 (2 rounds, 2 effects demanding 6_500 > quota 3_000) | FAILED | 1 member | the honest precondition shape — the guard rejects BEFORE any dispatch; the guard-rejection trajectory is a first-class frozen reference |
| research-digest-rerun-equivalence | portfolio:research v1 | golden:research-digest r1 (1 round, 1 effect, quota 4_000 ≥ 1_200) | COMPLETED | 1 member | the control re-run probe — the re-run must reproduce the recorded class and NEVER mint a second ledger identity |
| probe-reuse-contamination | portfolio:rag v1 | golden:rag-retrieval-probe r1 (2 rounds, 2 effects) | COMPLETED | 1 member | the `trajectory-reuse` contamination hook (pinned now, driven by the discrimination phase) |
| probe-caching-hint-contamination | portfolio:tool-agent v1 | golden:tool-loop-probe r1 (3 rounds, 1 effect) | COMPLETED | 1 member | the `caching-hint` contamination hook |
| probe-competence-shortcut-contamination | portfolio:coding v1 | golden:coding-probe r1 (2 rounds, 1 effect) | COMPLETED | 1 member | the `competence-shortcut` contamination hook |

## Live rail row (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-control-dispatch | `OPENROUTER_API_KEY` | ONE REAL model confirmation round through the REAL platform model gateway — the control run makes its OWN dispatch (measured usage, never estimated, never fabricated) | COMPLETED; trajectory in-class; usage measured |

## Pinned policies

- **Control semantics**: learning explicitly INERT (`control.learning =
  "inert"` rides the task body — task semantics, never provider
  selection). No reuse of prior trajectories, no caching hints, no
  competence shortcuts; the control run makes its OWN dispatches (the
  under-dispatch of a reused or shortcut round is mechanically visible
  in the public route read).
- **Freeze discipline**: the manifest is content-addressed (digests
  over the pinned artifacts); the registry is append-only — a
  correction is a NEW workload revision (a new registry entry), never
  an edit of a committed one.
- **Re-run discipline**: the re-run re-issues EXACTLY the submission
  key with the IDENTICAL body; the ledger must replay the SAME
  identity and the re-observed trajectory must stay in the recorded
  equivalence class.
- **Accounting honesty**: latency is always measured; usage is
  measured on the live rail and honestly none-reported offline.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals
  (`src/**` is never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the control-run
  semantics are ledger-level (the admission guard, the inert dispatch
  rounds, the recorder's trajectory capture and the longitudinal
  ledger are the system under test; the deterministic digests are the
  oracle).
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free
  (`config.json` mirrors the exported task slice); the single secret
  is the environment token (`ZECK_VALIDATION_TOKEN`), and the live
  row's credential is env-gated (`OPENROUTER_API_KEY`).

## Run

Executed by the validation suites: the unit battery
(`tests/unit/validation/val-030-apps.test.ts` over the deterministic
fake world and `tests/unit/validation/val-030-platform.test.ts` over
the platform slice's pure derivations), with the REAL end-to-end
integration run env-gated in the validation integration suite
(drives the pinned control corpus over the REAL platform path).
