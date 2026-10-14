/**
 * The threshold report renderer (PCL-003 — the durable evidence
 * document).
 *
 * Renders the declared-before/verdict-after evidence: every threshold
 * with its verdict (met / missed — a miss carries its honest
 * attribution), the per-failure-class percentile decompositions (every
 * class and route, never aggregate-only), the cost-truth lines with
 * their explicit bases, the resolution honesty, the census
 * reconciliation proof, the mechanical promotion-gate verdict, the
 * PPR-027 cell replay table (the recorded capstone-era numbers quoted
 * VERBATIM beside the fresh re-run), and the reproducibility proof.
 *
 * Every number carries its synthetic label; wall-clock and run
 * identities appear ONLY here (never in any digest projection).
 */

import type { ArmMeasuredSummary, CellEvaluationResult, EvaluationAggregate } from "./driver";
import type { PercentileRow } from "./percentiles";

/** The renderer's inputs (the aggregate + the reproducibility record). */
export interface ThresholdReportInput {
  readonly aggregate: EvaluationAggregate;
  readonly cells: readonly CellEvaluationResult[];
  readonly runRevision: string;
  readonly runStartedAt: string;
  readonly reRunDigest: string | null;
  readonly corpusDigest: string;
  readonly thresholdsDigest: string;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function percentileCell(row: PercentileRow, key: "p50Ms" | "p95Ms" | "p99Ms"): string {
  const value = row[key];
  return value === null ? "—" : `${value} ms`;
}

function percentileTable(rows: readonly PercentileRow[], groupLabel: string): string {
  const header = `| ${groupLabel} | samples | p50 | p95 | p99 | mean | max |`;
  const separator = "|---|---|---|---|---|---|---|";
  const body = rows
    .map(
      (row) =>
        `| ${row.key} | ${row.samples} | ${percentileCell(row, "p50Ms")} | ${percentileCell(row, "p95Ms")} | ${percentileCell(row, "p99Ms")} | ${row.meanMs === null ? "—" : `${row.meanMs} ms`} | ${row.maxMs === null ? "—" : `${row.maxMs} ms`} |`,
    )
    .join("\n");
  return `${header}\n${separator}\n${body}`;
}

function armSection(arm: ArmMeasuredSummary, title: string): string {
  const lines: string[] = [];
  lines.push(`### ${title} (\`${arm.armId}\`)`);
  lines.push("");
  lines.push(`- basis: ${arm.basis}`);
  lines.push(
    `- executions: ${arm.executions} — resolved ${arm.resolved} (${formatRate(arm.resolutionRate)}), failed ${arm.failed} (terminal ${arm.terminalFailures}); verification outcomes: ${arm.verificationOutcomes.pass} pass / ${arm.verificationOutcomes.notRun} not-run`,
  );
  lines.push("");
  lines.push(
    "**The overall outcome-latency tail** (every execution, resolved and terminal — synthetic-latency: the ladder's drawn latencies plus the paced waits; never wall-clock):",
  );
  lines.push("");
  lines.push(percentileTable([arm.overallOutcomeLatency], "population"));
  lines.push("");
  lines.push(
    "**The successful-outcome tail** (the resolved outcomes only — the capstone's own latency-tail pool; the T1 pool, guarded against failure-hiding by the T2 resolution leg):",
  );
  lines.push("");
  lines.push(percentileTable([arm.resolvedOutcomeLatency], "population"));
  lines.push("");
  lines.push(
    "**The per-failure-class outcome tail** (the end-to-end outcome latency of the executions whose legs encountered each class — every member of the closed taxonomy present; zero-sample classes render the honest no-samples spelling):",
  );
  lines.push("");
  lines.push(percentileTable(arm.outcomeLatencyByEncounteredClass, "failure class"));
  lines.push("");
  lines.push("**The per-outcome-class tail** (the closed outcome classification):");
  lines.push("");
  lines.push(percentileTable(arm.outcomeLatencyByClass, "outcome class"));
  lines.push("");
  lines.push(
    "**The per-failure-class/ROUTE leg table** (the completion-latency percentiles of the legs carrying each class on each route — the ACR-010 §5 decomposition, never aggregate-only):",
  );
  lines.push("");
  lines.push(percentileTable(arm.legPercentilesByClassAndRoute, "class@route"));
  lines.push("");
  lines.push("**The cost truth** (synthetic-price-schedule basis, every line explicit):");
  lines.push("");
  lines.push(
    `- total including duplicate attempts: **${arm.cost.totalIncludingDuplicates.microUsd} micro-USD** over ${arm.cost.dispatches} physical dispatches — basis: ${arm.cost.totalIncludingDuplicates.basis}`,
  );
  lines.push(
    `- the duplicates component (every attempt beyond the first): **${arm.cost.duplicates.microUsd} micro-USD** — basis: ${arm.cost.duplicates.basis}`,
  );
  lines.push(
    `- verification cost (its own line): **${arm.cost.verification.microUsd} micro-USD** — basis: ${arm.cost.verification.basis}`,
  );
  lines.push("");
  lines.push("**The attempt-census proof** (the exact reconciliation — no failure hiding):");
  lines.push("");
  lines.push(
    `- original ${arm.census.original} + retry ${arm.census.retry} + fallback ${arm.census.fallback} + verification ${arm.census.verification} = ${arm.census.original + arm.census.retry + arm.census.fallback + arm.census.verification} attempts = ${arm.census.attempts} (legs ${arm.census.legs}) — **${arm.census.reconciles ? "RECONCILES EXACTLY" : "DOES NOT RECONCILE (the automatic-void shape)"}**`,
  );
  lines.push(
    `- masked terminal failures: ${arm.maskedTerminalFailures}; dispatch-budget violations: ${arm.dispatchBudgetViolations}; max execution elapsed: ${arm.maxElapsedMs} ms`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Render the durable threshold report. */
export function renderThresholdReport(input: ThresholdReportInput): string {
  const { aggregate } = input;
  const lines: string[] = [];
  lines.push("# PCL-003 — Latency-Tail Evaluation: Threshold Report");
  lines.push("");
  lines.push(
    "The P3 program's evidence (ACR-010 §5, work order PCL-003): the per-failure-class percentiles, the cost truth, the resolution honesty, and the mechanical promotion gate over the honest replay of the PPR-027 capstone's latency cells under the typed-facts configuration.",
  );
  lines.push("");
  lines.push(
    "**Every number this evaluation emits is a fresh synthetic measurement** — synthetic-supply (the capstone's declared deterministic fault/latency profiles, drawn by the transport's own pure hash functions), synthetic-cost (the declared price schedule), synthetic-latency (the drawn profile plus the declared pacing delays — never wall-clock). No live/credentialed provider runs, no SLA or production-latency claims; live latency validation under real load is the operator-era obligation, never backfilled.",
  );
  lines.push("");
  lines.push("## Run identity (wall-clock — excluded from every digest)");
  lines.push("");
  lines.push(`- run revision: \`${input.runRevision}\``);
  lines.push(`- run started at: ${input.runStartedAt}`);
  lines.push(`- corpus digest: \`${input.corpusDigest}\``);
  lines.push(`- declared-thresholds digest: \`${input.thresholdsDigest}\``);
  lines.push(`- evaluation digest: \`${aggregate.evaluationDigest}\``);
  lines.push("");
  lines.push("## The declared thresholds and their honest verdicts");
  lines.push("");
  lines.push(
    "The declarations were committed BEFORE the run (`experiments/pcl-003/declared-thresholds.json` — the declared-before/verdict-after discipline). The verdicts below are DERIVED from the measured aggregates against those declarations — never asserted; a miss carries its attribution.",
  );
  lines.push("");
  const gate = aggregate.gate;
  for (const leg of gate.legs) {
    const verdict = leg.passed ? "MET" : "MISSED (with attribution)";
    lines.push(`### ${leg.legId} — ${leg.name}: **${verdict}**`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(leg.detail, null, 2));
    lines.push("```");
    if (leg.attribution !== null) {
      lines.push("");
      lines.push(`Attribution: ${leg.attribution}`);
    }
    lines.push("");
  }
  lines.push(`### THE PROMOTION GATE: **${gate.verdict}**`);
  lines.push("");
  lines.push(
    gate.verdict === "PROMOTED"
      ? `Every leg passed (T1–T4): the tail-tuned configuration is promoted by the mechanical gate — basis: ${gate.basis}`
      : `The failing legs: ${gate.failingLegs.join(", ")} — the tail-tuned configuration is NOT promoted (median improvement alone promotes nothing; the miss is reported with attribution above, never repaired). Basis: ${gate.basis}`,
  );
  lines.push("");
  lines.push("## The measured evidence per configuration");
  lines.push("");
  lines.push(
    armSection(aggregate.arms.baseline, "The baseline arm (the capstone's recorded posture)"),
  );
  lines.push(armSection(aggregate.arms.tuned, "The tuned arm (the PCL-002 configuration armed)"));
  lines.push("## The honest disclosures (the explicit-basis discipline)");
  lines.push("");
  lines.push(
    "- the latency model: the outcome latency is the ladder's arithmetic (the drawn per-attempt latencies plus the paced inter-attempt waits) — synthetic-latency, never wall-clock; the recorded capstone numbers (quoted below, verbatim) carry their OWN basis (wall-clock end-to-end under the synthetic supply) and are never relabeled or compared like-for-like;",
  );
  lines.push(
    "- the per-leg first-byte point renders the honest NOT RUN on every leg (owner: the synthetic supply declares no first-byte profile — the transport draws completion latency only);",
  );
  lines.push(
    "- the progress-delivery dimension is RECORDED (the mode and the applied interval ride every fact block), never latency-differentiated: the synthetic supplies are synchronous request/response draws — they model no progress-observation delay, and they declare no event-stream capability (the transport's own typed capability truth — the ACR-009 pattern). The event-stream and poll-quantization effects are operator-era live questions, never backfilled;",
  );
  lines.push(
    "- the replay is the re-dispatching posture (one fresh exposure per logical request occurrence): the capstone's durable-replay reuse axis is its own determinism-reuse dimension, out of this evaluation's scope (disclosed);",
  );
  lines.push(
    "- the zero-sample failure classes (connection-error, verification-retry, budget-exhausted, policy-denied) never appear in this synthetic world's draws — their rows render the honest no-samples spelling in every table above;",
  );
  lines.push(
    "- the synthetic supplies' fault vocabulary maps to the closed PCL-001 taxonomy by the declared mapping (rate-limit → provider-throttle, timeout → provider-timeout, provider-unavailable → provider-5xx).",
  );
  lines.push("");
  lines.push("## The PPR-027 cell replay (102 cells, per-cell honest verdicts)");
  lines.push("");
  lines.push(
    "Both arms re-ran FRESH over each cell's corpus (the exact-revision rule; the capstone's recorded numbers are NEVER reused as evaluation inputs). The recorded columns quote the capstone's committed results VERBATIM (their own wall-clock basis, synthetic-supply label preserved, never relabeled); the re-run columns are this evaluation's fresh typed-facts measurements (synthetic-latency basis).",
  );
  lines.push("");
  lines.push(
    "| cell | recorded (verbatim: median/p95/p99 ms, wall-clock) | re-run baseline (p95/p99 ms, drawn) | re-run tuned (p95/p99 ms, drawn) | recorded mediated attempts/successes | re-run resolved b/t | cell verdict | failing legs |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const cell of input.cells) {
    const recordedTail = cell.recorded.latencyTail;
    const recorded =
      recordedTail === null
        ? "not recorded"
        : `${String(recordedTail.medianMs ?? "—")}/${String(recordedTail.p95Ms ?? "—")}/${String(recordedTail.p99Ms ?? "—")}`;
    const recordedOutcomes = cell.recorded.mediatedOutcomes;
    const recordedOutcomesLabel =
      recordedOutcomes === null
        ? "—"
        : `${String(recordedOutcomes.attempts ?? "—")}/${String(recordedOutcomes.successes ?? "—")}`;
    const baseline = cell.arms.baseline.overallOutcomeLatency;
    const tuned = cell.arms.tuned.overallOutcomeLatency;
    lines.push(
      `| ${cell.cellId} | ${recorded} | ${baseline.p95Ms === null ? "—" : baseline.p95Ms}/${baseline.p99Ms === null ? "—" : baseline.p99Ms} | ${tuned.p95Ms === null ? "—" : tuned.p95Ms}/${tuned.p99Ms === null ? "—" : tuned.p99Ms} | ${recordedOutcomesLabel} | ${cell.arms.baseline.resolved}/${cell.arms.tuned.resolved} | ${cell.cellVerdict.verdict} | ${cell.cellVerdict.failingLegs.join(",") || "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    `Per-cell verdict tally: **${aggregate.cellVerdicts.passed} cells passed** / ${aggregate.cellVerdicts.missed} missed; failing-leg tallies: T1×${aggregate.cellVerdicts.failingLegTallies.T1 ?? 0}, T2×${aggregate.cellVerdicts.failingLegTallies.T2 ?? 0}, T3×${aggregate.cellVerdicts.failingLegTallies.T3 ?? 0}, T4×${aggregate.cellVerdicts.failingLegTallies.T4 ?? 0}.`,
  );
  lines.push("");
  lines.push("## T5 — the reproducibility proof");
  lines.push("");
  lines.push(
    input.reRunDigest === null
      ? "NOT RUN in this pass (the single mode) — the committed artifacts carry the run digest; the in-suite determinism proof re-runs the complete evaluation and requires the byte-identical digest."
      : `The complete evaluation re-ran and reproduced the evaluation digest **byte-for-byte** (${input.reRunDigest === aggregate.evaluationDigest ? "identical" : "DIVERGENT — a typed failure"}) — the deterministic replay discipline (wall-clock and run identities excluded from every digest projection).`,
  );
  lines.push("");
  lines.push("## NOT RUN boundaries (the honest spelling, with owners)");
  lines.push("");
  lines.push(
    "- live/credentialed provider latency validation under real load: NOT RUN (the operator-era obligation — owner: the operator; never backfilled by synthetic evidence);",
  );
  lines.push(
    "- SLA or production-latency claims: NOT MADE (this evaluation's numbers are synthetic-supply/synthetic-cost/synthetic-latency only);",
  );
  lines.push(
    "- the per-leg first-byte latency point: NOT RUN on every leg (owner: the synthetic supply declares no first-byte profile — owner within this program: PCL-003 evaluation);",
  );
  lines.push(
    "- the event-stream progress-delivery leg and the poll-quantization effect: NOT RUN (the synthetic supplies declare no event-stream capability and model no progress-observation delay — owner: the operator-era live validation).",
  );
  lines.push("");
  return lines.join("\n");
}
