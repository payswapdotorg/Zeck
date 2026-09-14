# production-pilot (VAL-051)

The PRODUCTION-STYLE PILOT WITH SUSTAINED OBSERVATION application: a
declared observation window over the RECORDED application portfolio
and the end-to-end customer journey (VAL-050), driven through the
REAL platform path (the public SDK boundary via the VAL-002
validation harness) under production-style operating discipline — a
declared **schedule of shifts** replaying recorded workloads (their
recorded input digests chained through the VAL-050 journey into
VAL-049's audited economics), **budgets and policies enforced for the
whole window**, **incidents handled through the recorded
failure/continuation machinery** (a resumed shift continues exactly
once — never dropped, never double-driven), **drift honestly
classified** (within declared bounds / drifting with the mechanism
named / regressing reported as regressing), the **customer boundary
respected across the entire window** and the **end-of-window
accounting reconciling shift-for-shift against the recorded basis**.

Per the work order (`spec/validation-work-orders/VAL-051.md`):

- the pilot **composes the RECORDED corpora** where its shifts replay
  recorded workloads — the recorded input digests and audited
  economics are carried from the VAL-050 digest-chained journey
  (whose stages carry the VAL-049 audited basis), digest-referenced,
  never re-measured, never re-priced (pure derivation over RECORDED
  results — a re-measurement masquerading as pilot observation
  FAILs);
- pilot-level integrity is **mechanical** (all eight families):
  window honesty (a cherry-picked sub-window FAILs with the omitted
  segments named), schedule completeness (a missing or duplicated
  shift FAILs named), continuation exactly-once (a double-driven or
  undeclared resume FAILs named), drift-classification honesty (a
  silently normalized drift or hidden regression FAILs with the
  segment and mechanism named), incident honesty (a hidden,
  unattributed or undeclared incident FAILs named), budget-policy
  envelope integrity (reservations settle, no unauthorized spend, the
  ledger is append-only), end-of-window accounting reconciliation (an
  unexplained window-level residual FAILs with the amount named) and
  customer-boundary integrity (a cross-tenant shift FAILs named).

## Files

- `corpus.ts` — the declared pilot rows: per row the pilot shape (the
  observation window, the schedule of shifts with their recorded
  input digests and carried economics), the operating discipline
  (reservations, latency policy, the window budget, the drift bands,
  the declared incidents and drift) and the expected verdict
  (`PILOT-COMPLETED` / `PILOT-FAILED` with the failed criteria NAMED
  / `NOT-RUN` with the env var named).
- `driver.ts` — the app-local pilot machinery: the deterministic
  sustained-observation derivation (pure derivation over the recorded
  basis) and the eight mechanical observation oracles
  (`verifyProductionPilotIntegrity` — PURE, re-derived at the
  customer boundary over the public result read).
- `fixtures.ts` — the deterministic fixtures: the transport-level
  fake public API world (the create/replay semantics, the honest
  outcome shapes, the pilot observation package at the result
  boundary) and the discrimination knobs (the controlled fakes of the
  AC6 battery: a cherry-picked window, a dropped shift, a duplicated
  resume, a normalized drift, a hidden incident, a hidden residual, a
  boundary leak). The offline fake world NEVER serves the live rail.
- `application.ts` — the app proper: submit the pilot task under its
  OWN idempotency key → poll the window to its terminal → retrieve
  the result (the verification statuses, the honest usage and the
  pilot observation) → re-derive the eight observation oracles AT THE
  BOUNDARY → the app-side pilot contract (honest-vocabulary pins).
- `config.json` — the secret-free, repository-reproducible
  configuration (the pinned task-slice mirror).

## The corpus (13 rows)

| row | shape | expected verdict |
| --- | --- | --- |
| `full-window-recorded-basis` | the canonical sustained-observation window over the full five-shift schedule (10% reservation headroom, the released remainder NAMED) | `PILOT-COMPLETED` |
| `window-incident-resume` | a mid-window incident at daily usage, resumed exactly once through the recorded failure/continuation machinery | `PILOT-COMPLETED` |
| `window-drift-within-bounds` | the intent shift deviates +64 microUsd / +12 ms — within the declared drift bands, honestly classified within-bounds | `PILOT-COMPLETED` |
| `window-drift-declared` | the daily-usage shift deviates +1152 microUsd — beyond the bands, honestly classified DRIFTING with the mechanism named | `PILOT-COMPLETED` |
| `window-regression-declared` | the outcome shift's quality falls to 0.72 — honestly reported AS REGRESSING with the mechanism named | `PILOT-COMPLETED` |
| `probe-window-cherry-picking` | the window observes only the first four shifts (a cherry-picked sub-window) | `PILOT-FAILED` — `window-honesty` + `end-of-window-accounting` |
| `probe-dropped-shift` | the daily-usage shift silently dropped from the window's records | `PILOT-FAILED` — `schedule-completeness` + `end-of-window-accounting` |
| `probe-double-driven-resume` | the declared incident's shift resumed twice (three executions) | `PILOT-FAILED` — `continuation-exactly-once` + `end-of-window-accounting` + `budget-policy-envelope` |
| `probe-drift-normalizing` | the beyond-band drift silently classified within-bounds, its delta normalized away | `PILOT-FAILED` — `drift-classification-honesty` + `end-of-window-accounting` |
| `probe-incident-hiding` | the resumed shift's incident never recorded in the incident log | `PILOT-FAILED` — `incident-honesty` |
| `probe-residual-hiding` | the reported window total hides half the daily-usage shift's observed spend | `PILOT-FAILED` — `end-of-window-accounting` |
| `probe-boundary-leak` | the daily-usage shift executes under another customer's identity | `PILOT-FAILED` — `customer-boundary` |
| `live-pilot-window` | one REAL live sustained-observation window with live dispatches | `NOT-RUN` without `OPENROUTER_API_KEY` |

## Running

The offline rows are deterministic and credential-free:

```sh
bun test tests/unit/validation/val-051-apps.test.ts tests/unit/validation/val-051-core.test.ts
```

The ONE live row (`live-pilot-window`) is env-gated on
`OPENROUTER_API_KEY` (the operator-authorized rail): without the
credential it is honestly `NOT-RUN` (the env var named in the verdict
and the evidence); the offline fake world refuses the live rail
outright — a live pilot window is never fabricated offline. The live
lane is driven by the Lead's live review over the REAL platform path
with the REAL recorder and honest measured economics.
