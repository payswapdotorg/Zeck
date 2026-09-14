# final-report (VAL-052)

The FINAL VALIDATION REPORT, FINDINGS, SOLUTIONS AND RELEASE GATE
application: the consolidated evidence inventory of the ENTIRE
validation program — every registered work order VAL-001..052 with its
registered title, completion status, evidence document resolved at its
registered location (`benchmarks/validation/evidence/VAL-001.md` for
VAL-001; `docs/work-items/VAL-0NN.md` for the rest) and its
merge/finalize record cited where recorded — plus the mechanical
NINE-CONDITION RELEASE GATE, each condition adjudicated from the
RECORDED evidence with the evidence NAMED (zero subjective judgment).
The inventory is pure derivation over the RECORDED governed program
state (`spec/validation-state/*.json`, READ-ONLY data at run time) and
the evidence documents (content-digest referenced, never copied, never
re-measured); this work order adds NO new product surface and NO new
workload corpus.

Per the work order (`spec/validation-work-orders/VAL-052.md`):

- the report engine READS the governed state as data (an edit to
  `spec/validation-state/**` is the forbidden surface — the Lead's
  finalize owns the state files);
- the gate verdict derives over the governed program state: an
  incomplete work order, a missing evidence document, a reasonless
  NOT RUN boundary, a protocol-less finding or an unprovenanced claim
  each FAILs with the offender NAMED;
- deadline-remainder honesty: the completion timestamp, the remaining
  window against the 2026-09-15T00:00:00Z operator deadline, and any
  work order not complete at report time NAMED with its status (VAL-052
  itself — the in-flight work order — never silently dropped);
- the Architect's acceptance is carried by the authority chain
  (PR → CI → merge → program-state finalize), NEVER self-declared by
  the report;
- the verdict vocabulary is honest and mechanical — COMPLETED /
  FAILED with the criterion NAMED / NOT-RUN with the gating env var
  named.

## Files

- `corpus.ts` — the declared report rows: per row the report shape
  (the program slice under inventory and its recorded evidence
  references), the gate families under test and the expected verdict
  (`COMPLETED` / `FAILED` with the failed criteria NAMED / `NOT-RUN`
  with the env var named); plus the recorded evidence registries (the
  application categories, the integration paths, the thresholds, the
  learning chain, the economic comparisons, the NOT RUN boundaries,
  the material findings, the reproducibility records).
- `driver.ts` — the app-local report machinery: the REAL-world loader
  (`loadRealReportWorld` — the governed state + evidence documents as
  READ-ONLY data), the deterministic package derivation
  (`reportPackageFor`), the consolidated inventory
  (`consolidatedInventoryOf`), the THIRTEEN mechanical oracles
  (`verifyFinalReportIntegrity` — the three inventory oracles, the
  NINE release-gate conditions, the deadline-remainder honesty), the
  verdict derivation (`deriveReleaseGateVerdict`) and the
  nine-condition adjudication view (`releaseGateAdjudicationOf`).
- `fixtures.ts` — the deterministic fixtures: the transport-level fake
  public API world (the create/replay semantics, the honest outcome
  shapes, the report package at the result boundary), the fake report
  worlds (controlled governed-state fakes for the discrimination
  battery) and the discrimination knobs (the controlled fakes: a
  missing work order, a deleted evidence document, a reasonless NOT
  RUN boundary, a protocol-stripped finding, a phantom coverage claim,
  a silently dropped incomplete work order, a self-declared
  acceptance). The offline fake world NEVER serves the live rail.
- `application.ts` — the app proper: submit the report task under its
  OWN idempotency key → poll the report to its terminal → retrieve
  the result (the verification statuses, the honest usage and the
  report package) → re-derive the thirteen oracles AT THE BOUNDARY
  over the world of record → the app-side report contract
  (honest-vocabulary pins).
- `config.json` — the secret-free, repository-reproducible
  configuration (the pinned task-slice mirror + the corpus digest).

## The corpus (13 rows)

| row | shape | expected verdict |
| --- | --- | --- |
| `inventory-consolidated-governed-state` | the consolidated evidence inventory over the REAL governed state (46 registered work orders, 45 complete + VAL-052 honestly in flight) | `COMPLETED` |
| `release-gate-nine-conditions` | the nine release-gate conditions adjudicated from the recorded evidence, evidence NAMED per condition | `COMPLETED` |
| `program-coverage-and-disclosures` | the coverage / NOT RUN disclosures / findings sections over the recorded evidence | `COMPLETED` |
| `deadline-remainder-honest` | the completion timestamp + the remaining window vs the operator deadline, VAL-052 NAMED | `COMPLETED` |
| `acceptance-chain-carried` | the Architect's acceptance carried by the authority chain, VAL-052 honestly pending | `COMPLETED` |
| `probe-missing-work-order` | the inventory omits VAL-031 | `FAILED` — `inventory-completeness` |
| `probe-deleted-evidence-document` | VAL-033's evidence document does not resolve at its registered location | `FAILED` — `inventory-evidence-resolution` |
| `probe-boundary-without-env-var` | a NOT RUN boundary without its gating env var named | `FAILED` — `gate-not-run-disclosure` |
| `probe-protocol-stripped-finding` | a material finding stripped of its seven-part solution protocol | `FAILED` — `gate-findings-protocol` |
| `probe-phantom-coverage` | a phantom coverage row + inventory entry citing the never-registered VAL-027 | `FAILED` — `inventory-completeness` + `gate-category-coverage` |
| `probe-silent-omission` | the incomplete VAL-052 silently dropped from the deadline accounting | `FAILED` — `deadline-remainder-honesty` |
| `probe-self-declared-acceptance` | the report self-declares the Architect's acceptance | `FAILED` — `acceptance-chain-honesty` |
| `live-gate-confirmation-slice` | one REAL live confirmation slice at the pinned rail | `NOT-RUN` without `OPENROUTER_API_KEY` |

## Running

The offline rows are deterministic and credential-free:

```sh
bun test tests/unit/validation/val-052-apps.test.ts tests/unit/validation/val-052-core.test.ts
```

The ONE live row (`live-gate-confirmation-slice`) is env-gated on
`OPENROUTER_API_KEY` (the operator-authorized rail): without the
credential it is honestly `NOT-RUN` (the env var named in the verdict
and the evidence); the offline fake world refuses the live rail
outright — a live confirmation is never fabricated offline. The live
lane is driven by the Lead's live review over the REAL platform path
with the REAL recorder and honest measured economics.
