# Zeck Validation Report

**Status:** OPEN — cumulative report
**Program:** `docs/VALIDATION-ROADMAP.md`
**Repository:** `payswapdotorg/Zeck`

This report is maintained throughout validation. It must distinguish observed evidence from interpretation and recommendations.

## Executive summary

_To be populated from exact-revision validation runs._

## Application coverage

| Workload | App | Corpus version | Runs | Quality | Reliability | Cost/success | Status |
|---|---|---:|---:|---:|---:|---:|---|
| Text | TBD | — | — | — | — | — | OPEN |
| Structured transformation | TBD | — | — | — | — | — | OPEN |
| RAG | TBD | — | — | — | — | — | OPEN |
| Tool agent | TBD | — | — | — | — | — | OPEN |
| Business workflow | TBD | — | — | — | — | — | OPEN |
| Long-running agent | TBD | — | — | — | — | — | OPEN |
| Voice/realtime | TBD | — | — | — | — | — | OPEN |
| Image generation | TBD | — | — | — | — | — | OPEN |
| Video/media generation | TBD | — | — | — | — | — | OPEN |
| Vision/VLM/audio | TBD | — | — | — | — | — | OPEN |
| Multimodal/3D | TBD | — | — | — | — | — | OPEN |
| Customer service | TBD | — | — | — | — | — | OPEN |
| Browser/computer use | TBD | — | — | — | — | — | OPEN |
| Research/coding/operations | TBD | — | — | — | — | — | OPEN |
| Human-in-the-loop | TBD | — | — | — | — | — | OPEN |

## Longitudinal learning

Track baseline → repeated replay → learned optimization → shadow → canary → rollback/promote. Report deterministicization ratio, AI avoidance ratio, learned savings and quality preservation.

## Economic benchmark

Compare Zeck against direct-provider, strong optimized non-Zeck and relevant competing stacks. Primary metric: cost per successfully resolved outcome at comparable quality/reliability/safety thresholds.

## Findings and solutions

For every material issue:

- exact reproduction;
- affected application/work order;
- revisions and environment;
- observed impact;
- root-cause classification;
- candidate solutions;
- recommended solution and trade-offs;
- verification required;
- disposition.

## Observed facts

_Every entry names the exact submission (work order + final head) and the
battery command that produced it. Facts are observations only — no
interpretation. Populated by the report projection
(`benchmarks/validation/report.ts`) from validated submissions
(`benchmarks/validation/submission.ts`)._

| Work order | Command | Outcome | Detail | Source |
|---|---|---|---|---|
| — | — | — | — | — |

## Failures and root causes

_Failed battery commands and every material issue, each with its
seven-part solution protocol (reproduction, impact, root-cause
classification, viable solutions, recommended solution with trade-offs,
defect classification, required verification evidence)._

| Work order | Failure | Root cause | Classification | Status |
|---|---|---|---|---|
| — | — | — | — | — |

## Hypotheses (open)

_Interpretation lives here, never in the facts section. A hypothesis is
recorded explicitly with the experiment that would confirm or refute
it; none is promoted to a finding without that evidence._

| Hypothesis | Confirming experiment | Status |
|---|---|---|
| — | — | — |

## Recommendations

_Each recommendation traces to the issue or finding that produced it
and names the verification required before it is acted on._

| Recommendation | Traces to | Verification required | Status |
|---|---|---|---|
| — | — | — | — |

## NOT RUN boundaries

_An unavailable run is recorded with its exact reason and surfaced to
the operator as a missing-access requirement. A NOT RUN boundary never
converts into a pass._

| Surface | Exact reason | Surfaced to operator |
|---|---|---|
| — | — | — |

## Provider/model coverage and access

Record models/providers actually exercised. Record unavailable provider/model access as NOT RUN with exact reason. Never include credentials or secrets.

## Reproducibility

Every claimed result must identify application revision, Zeck revision, corpus version, experiment/run identity, environment class, relevant configuration and exact evidence location. Run identities are derived deterministically by the validation laboratory (`benchmarks/validation/run-identity.ts`); the governed program state is `spec/validation-state/` (checked by `scripts/validation-check.py` and the CI validation tests under `tests/unit/validation/`).

## Final recommendation

_To be completed by VAL-052._
