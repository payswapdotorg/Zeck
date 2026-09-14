# production-pilot (VAL-051)

The PRODUCTION-STYLE PILOT application: a **declared schedule of
shifts** replaying the recorded end-to-end customer journey (VAL-050)
— each shift's stages carrying their audited VAL-049 economics as the
pilot's cost basis — observed under production-style operating
discipline (per `spec/validation-work-orders/VAL-051.md`):

- **the re-measurement ban**: every offline observation is PURE
  derivation over the RECORDED corpora (digest-referenced through
  their own resolvers — `journeyRowById`, `auditRowById`,
  `replayRecordedEvidenceOf`), honestly labeled
  `derived-from-recorded-basis`, never claimed as a measurement;
- **the verdict vocabulary** (never a narrative):
  `PILOT-COMPLETED` / `PILOT-FAILED` (the FAILing criteria NAMED) /
  `NOT-RUN` (the env var named);
- **the three-way drift vocabulary**: `within-declared-bounds` /
  `drifting` (the mechanism NAMED — a declared divergence WITH cause)
  / `regressing` (reported AS regressing, never normalized) — the
  CLAIMED classification must equal the DERIVED one;
- **the eight observation families** (one oracle per issued AC4
  criterion): window honesty, schedule completeness, continuation
  exactly-once, drift-classification honesty, incident honesty,
  budget/policy envelope, end-of-window reconciliation, customer
  boundary.

## Files

- `driver.ts` — the app-local pilot engine: the declared-window and
  shift-schedule machinery, the replay derivation, the append-only
  budget/policy ledger, the drift derivation and the EIGHT PURE
  oracles (`drivePilotRow` — the 8-criteria synthesis).
- `corpus.ts` — the declared 14 rows: per row the pilot shape (its
  declared window, schedule of shifts, operating profile, drift
  factors and declared incidents), the observation families under
  test and the expected verdict — pinned by RUNNING the engine at
  module load (a drifted corpus THROWS before any window can be
  observed). Exports `PILOT_CORPUS_ROWS`, `PROBE_MECHANISM_OF`,
  `PROBE_FAILED_CRITERIA_OF`.
- `config.json` — the secret-free, repository-reproducible
  configuration (the pinned task slice mirror, digest-matched).
- `fixtures.ts` / `application.ts` — later missions.

## The corpus (14 rows)

| row | shape | expected verdict |
| --- | --- | --- |
| `pilot-window-full-recorded-portfolio` | 6 shifts replaying the recorded portfolio; every segment within bounds | `PILOT-COMPLETED` |
| `pilot-shift-resume-exactly-once` | shift 3 declares the mid-shift failure, resumed exactly once | `PILOT-COMPLETED` |
| `pilot-drift-drifting-named` | shift 4's daily-usage drifts WITH the cause declared | `PILOT-COMPLETED` (`drifting:load-shaping cohort mix`) |
| `pilot-drift-regressing-reported` | shift 5's segment regresses UNdeclared, reported AS regressing | `PILOT-COMPLETED` (`regressing`) |
| `pilot-incident-recorded-attributed` | a retryable provider-class + a non-retryable tool-class incident, each dispositioned | `PILOT-COMPLETED` |
| `pilot-budget-reservations-settled` | a tight window budget; reservations settle exactly | `PILOT-COMPLETED` |
| `probe-pilot-cherry-picked-window` | the anomalous shifts 4–5 dropped from the window record | `PILOT-FAILED` — `window-honesty` + `schedule-completeness` + `end-of-window-reconciliation` |
| `probe-pilot-dropped-shift` | scheduled shift 3 omitted entirely | `PILOT-FAILED` — `window-honesty` + `schedule-completeness` + `end-of-window-reconciliation` |
| `probe-pilot-double-driven-resume` | the resumed shift 3 driven twice (three attempts) | `PILOT-FAILED` — `continuation-exactly-once` + `end-of-window-reconciliation` |
| `probe-pilot-drift-normalizing` | the regressing segment's drift normalized back within bounds | `PILOT-FAILED` — `drift-classification-honesty` + `end-of-window-reconciliation` |
| `probe-pilot-incident-hiding` | the incident log omits the shift-2 incident | `PILOT-FAILED` — `incident-honesty` + `end-of-window-reconciliation` |
| `probe-pilot-residual-hiding` | the reported window total hides part of a shift's stage cost | `PILOT-FAILED` — `end-of-window-reconciliation` |
| `probe-pilot-boundary-leak` | one shift's stages execute under the foreign identity | `PILOT-FAILED` — `customer-boundary-integrity` |
| `live-pilot-real-window-slice` | 3 shifts × 2 REAL dispatches sustained over the live rail | `NOT-RUN` without `OPENROUTER_API_KEY` |

## The live rail

The ONE live row is env-gated on `OPENROUTER_API_KEY`: the pinned
live plan — 3 shifts × 2 REAL dispatches (six sustained, 1500ms on /
500ms off) over the ONE pinned OpenRouter rail, recorded through the
REAL recorder with honest MEASURED economics, classified against the
recorded basis. Without the credential it is honestly `NOT-RUN`
(never a fake success); the verdict is derived from the measured
facts, never pinned.

## Boundaries

Digest-only evidence (payload DIGESTS, never payload bytes); zero
credentials in the repository; the thirteen offline rows drive purely
with zero network; nothing re-drives a recorded workload, nothing
re-prices a recorded input.
