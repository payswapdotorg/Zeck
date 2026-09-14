# customer-journey (VAL-050)

The END-TO-END CUSTOMER JOURNEY application: the complete customer
lifecycle — **onboarding → intent → plan → daily usage over the
recorded application portfolio → outcome** — driven through the REAL
platform path (the public SDK boundary via the VAL-002 validation
harness), with the audited economics (VAL-049) carried as the
journey's cost basis.

Per the work order (`spec/validation-work-orders/VAL-050.md`):

- the journey **composes the RECORDED corpora** where its stages
  replay recorded workloads — the daily-usage stage drives the
  RECORDED application portfolio (the VAL-010 text apps' recorded
  fixture slices and the VAL-019 broad suite's recorded
  customer-service tasks), referenced by content digest, never
  re-measured, never re-priced;
- journey-level integrity is **mechanical**: stage completeness (a
  journey missing a stage FAILs with the stage named), cross-stage
  idempotency (every submitted intent lands exactly one durable
  execution — no orphaned state), continuation exactly-once (a
  mid-journey failure resumes exactly once, never duplicates),
  customer boundary (no cross-tenant leak at any stage) and
  end-to-end accounting reconciliation (the journey's cost/latency
  accounting reconciles stage-for-stage against the recorded stage
  economics — an unexplained journey-level residual FAILs with the
  residual named).

## Files

- `corpus.ts` — the declared journey rows: per row the journey shape
  (its stages and their recorded input digests), the integrity
  families under test and the expected verdict
  (`JOURNEY-COMPLETED` / `JOURNEY-FAILED` with the failed criteria
  NAMED / `NOT-RUN` with the env var named). The per-stage recorded
  economics are carried from VAL-049's audited rows (each anchored by
  a basis digest re-derived over the audit row's own recorded evidence
  digests).
- `driver.ts` — the app-local journey machinery: the deterministic
  journey observation (pure derivation over the recorded basis) and
  the five mechanical integrity oracles (`verifyCustomerJourneyIntegrity`
  — PURE, re-derived at the customer boundary over the public result
  read).
- `fixtures.ts` — the deterministic fixtures: the transport-level fake
  public API world (the create/replay semantics, the honest outcome
  shapes, the journey observation package at the result boundary) and
  the discrimination knobs (the controlled fakes of the AC6 battery:
  a dropped stage, an orphaned state, a duplicated resume, a boundary
  leak, a hidden residual). The offline fake world NEVER serves the
  live rail.
- `application.ts` — the app proper: submit the journey task under its
  OWN idempotency key → poll to the terminal → retrieve the result
  (the verification statuses, the honest usage and the journey
  observation) → re-derive the five integrity oracles AT THE BOUNDARY
  → the app-side journey contract (honest-vocabulary pins).
- `config.json` — the secret-free, repository-reproducible
  configuration (the pinned task slice mirror).

## The corpus (9 rows)

| row | shape | expected verdict |
| --- | --- | --- |
| `full-journey-recorded-portfolio` | the canonical full lifecycle over the recorded portfolio | `JOURNEY-COMPLETED` |
| `journey-continuation-resume` | a mid-journey failure at daily usage, resumed exactly once | `JOURNEY-COMPLETED` |
| `journey-idempotent-reissue` | the identical re-issue under the same key replays (never double-creates) | `JOURNEY-COMPLETED` |
| `probe-dropped-stage` | the daily-usage stage silently dropped | `JOURNEY-FAILED` — `stage-completeness` + `accounting-reconciliation` |
| `probe-orphaned-state` | the daily-usage intent submitted but never landed | `JOURNEY-FAILED` — `cross-stage-idempotency` + `accounting-reconciliation` |
| `probe-double-driven-resume` | the mid-journey failure resumed twice | `JOURNEY-FAILED` — `continuation-exactly-once` + `accounting-reconciliation` |
| `probe-boundary-leak` | the daily-usage stage executes under another customer's identity | `JOURNEY-FAILED` — `customer-boundary` |
| `probe-residual-hiding` | the journey total hides part of the daily-usage cost | `JOURNEY-FAILED` — `accounting-reconciliation` |
| `live-journey-slice` | one REAL live journey slice with live dispatches | `NOT-RUN` without `OPENROUTER_API_KEY` |

## Running

The offline rows are deterministic and credential-free:

```sh
bun test tests/unit/validation/val-050-apps.test.ts tests/unit/validation/val-050-core.test.ts
```

The ONE live row (`live-journey-slice`) is env-gated on
`OPENROUTER_API_KEY` (the operator-authorized rail): without the
credential it is honestly `NOT-RUN` (the env var named in the verdict
and the evidence); the offline fake world refuses the live rail
outright — a live journey is never fabricated offline. The live lane
is driven by the Lead's live review over the REAL platform path with
the REAL recorder and honest measured economics.
