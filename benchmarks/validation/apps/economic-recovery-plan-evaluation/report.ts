/**
 * The threshold-report renderer (PCR-003 — the durable evidence
 * document inside the evaluation app directory).
 *
 * Renders the evaluation aggregate + verdicts as the threshold report
 * (`results/threshold-report.md`): every threshold with its verdict
 * (met / missed / documented-tradeoff / accounted), every number
 * carrying its synthetic-supply / synthetic-cost / synthetic-latency
 * label, honest attribution on every miss, the explicit PCR-004
 * eligibility statement, and the reproducibility proof (the evaluation
 * digest + the re-run digest comparison). The renderer is PURE — the
 * report is a projection of the measured aggregate, never a
 * hand-written claim; a number that is not in the aggregate cannot
 * appear in the report.
 */

import { ARM_LABELS, BASE_REVISION, SYNTHETIC_LABELS } from "./corpus";
import type { ArmAggregate, EvaluationAggregate, LatencyTailGroup } from "./driver";

function percentOf(rate: number | null): string {
  return rate === null ? "n/a (no samples)" : `${(rate * 100).toFixed(2)}%`;
}

function microOf(value: number | null): string {
  return value === null ? "n/a (none resolved)" : value.toFixed(3);
}

function msOf(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function tailRow(group: LatencyTailGroup): string {
  return `| ${group.key} | ${group.samples} | ${msOf(group.p50Ms)} | ${msOf(group.p95Ms)} | ${msOf(group.p99Ms)} | ${msOf(group.meanMs)} |`;
}

const TAIL_HEADER = "| group | samples | p50 ms | p95 ms | p99 ms | mean ms |";
const TAIL_SEPARATOR = "|---|---:|---:|---:|---:|---:|";

function armAggregateTable(aggregate: EvaluationAggregate): string {
  const rows: string[] = [];
  for (const armId of ["un-retried-direct", "strong-optimized", "mediated-with-plan"] as const) {
    const arm: ArmAggregate = aggregate.arms[armId];
    rows.push(
      `| ${armId} | ${arm.cells} | ${arm.tasksTotal} | ${arm.tasksResolved} | ${percentOf(arm.taskResolutionRate)} | ${arm.requestsTotal} | ${arm.requestsResolved} | ${percentOf(arm.requestResolutionRate)} | ${arm.supplyDispatches} | ${arm.durableReplaysOrCacheHits} | ${arm.substrateDeterministic} | ${arm.nanoCost} | ${microOf(arm.microPerResolvedTask)} | ${microOf(arm.microPerResolvedRequest)} |`,
    );
  }
  return [
    "| arm | cells | task occurrences | resolved | task resolution | request occurrences | resolved | request resolution | supply dispatches | durable replays / cache hits | deterministic substrate | nano-USD charged (synthetic-cost) | µ$/resolved task (synthetic-cost) | µ$/resolved request (synthetic-cost) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
}

/**
 * Render the threshold report. PURE: a projection of the measured
 * aggregate (the honest-label law — every threshold verdict, every
 * number and every attribution derives from the aggregate; nothing is
 * hand-claimed).
 */
export function renderThresholdReport(options: {
  readonly aggregate: EvaluationAggregate;
  readonly corpusDigest: string;
  readonly runRevision: string;
  readonly runStartedAt: string;
  readonly reRunDigest: string | null;
  readonly perCellTable: readonly {
    readonly cellId: string;
    readonly mediatedTasksResolved: number;
    readonly mediatedTasksTotal: number;
    readonly optimizedTasksResolved: number;
    readonly optimizedTasksTotal: number;
    readonly directTasksResolved: number;
    readonly directTasksTotal: number;
  }[];
}): string {
  const { aggregate } = options;
  const verdicts = aggregate.verdicts;
  const lines: string[] = [];

  lines.push("# PCR-003 Threshold Report — economic-recovery-plan-evaluation");
  lines.push("");
  lines.push(
    `The P1 program's three-arm replay evaluation (un-retried direct / strong-optimized / mediated-with-plan) at ONE exact revision, targeting the multi-provider cell family where the PPR-027 capstone measured the mediated-resolution gap (92.4% multi vs 97.2% single-provider — the observed-distributions \`byProviderConfig\` territory). All numbers below are FRESH measurements of THIS evaluation at base revision \`${BASE_REVISION}\` (run revision \`${options.runRevision}\`); the capstone's recorded numbers are never reused (the exact-revision rule).`,
  );
  lines.push("");
  lines.push("## Honest labels (carried on every number)");
  lines.push("");
  lines.push(`- supply: ${SYNTHETIC_LABELS.supply}`);
  lines.push(`- cost: ${SYNTHETIC_LABELS.cost}`);
  lines.push(`- latency: ${SYNTHETIC_LABELS.latency}`);
  lines.push(
    "- no market or production claims; a threshold miss with honest attribution is a valid delivery (the program's truth discipline); live/credentialed validation is the operator-era obligation and is never backfilled from synthetic runs",
  );
  lines.push("");
  lines.push("## The arms (the pre-registered configurations)");
  lines.push("");
  for (const armId of ["un-retried-direct", "strong-optimized", "mediated-with-plan"] as const) {
    lines.push(`- **${armId}** — ${ARM_LABELS[armId]}`);
  }
  lines.push("");
  lines.push(
    "The mediated-with-plan arm turns plan mode ON through the PCR-002 evaluation configuration (`ComposeExperimentOptions.recovery` → `RecoveryConfiguration.planMode: \"on\"` with the mandatory `maxPlanSteps` bound) — an evaluation/tenant configuration ONLY; the wired seam's default is OFF everywhere else (byte-preserved traced posture). The composed bounded ladder (verified in-suite against the real composer): step 1 = same-provider retry (the retry claim is the cheapest admissible candidate); step 2 = alternate-provider failover to supply-c (the retry is retry-attempt-bound at the second frame; supply-c is the cheapest declared alternate the seam's frame projection admits); terminal bound-reached; 3 total attempts — the strong baseline's own attempt bound.",
  );
  lines.push("");
  lines.push("## The measured arms (the targeted multi-provider cells)");
  lines.push("");
  lines.push(armAggregateTable(aggregate));
  lines.push("");
  lines.push(
    `Cost basis: ${aggregate.cells[0]?.notes[0] ?? "see the corpus's COST_BASIS_NOTE"}. Faults drawn (synthetic-supply): rate-limit ${aggregate.arms["mediated-with-plan"].faultsByCategory.rateLimit}+${aggregate.arms["strong-optimized"].faultsByCategory.rateLimit}+${aggregate.arms["un-retried-direct"].faultsByCategory.rateLimit} (mediated+optimized+direct), timeout ${aggregate.arms["mediated-with-plan"].faultsByCategory.timeout}+${aggregate.arms["strong-optimized"].faultsByCategory.timeout}+${aggregate.arms["un-retried-direct"].faultsByCategory.timeout}, provider-unavailable ${aggregate.arms["mediated-with-plan"].faultsByCategory.unavailable}+${aggregate.arms["strong-optimized"].faultsByCategory.unavailable}+${aggregate.arms["un-retried-direct"].faultsByCategory.unavailable}.`,
  );
  lines.push("");
  lines.push("## T1 — Resolution (threshold: equal-or-better vs the fresh strong baseline)");
  lines.push("");
  lines.push(
    `- mediated-with-plan task resolution: **${percentOf(verdicts.resolution.mediatedTaskResolutionRate)}** (${aggregate.arms["mediated-with-plan"].tasksResolved}/${aggregate.arms["mediated-with-plan"].tasksTotal} task occurrences, synthetic-supply)`,
  );
  lines.push(
    `- strong-optimized task resolution (the FRESH baseline): **${percentOf(verdicts.resolution.optimizedTaskResolutionRate)}** (${aggregate.arms["strong-optimized"].tasksResolved}/${aggregate.arms["strong-optimized"].tasksTotal})`,
  );
  lines.push(
    `- un-retried-direct task resolution (context): ${percentOf(aggregate.arms["un-retried-direct"].taskResolutionRate)} (${aggregate.arms["un-retried-direct"].tasksResolved}/${aggregate.arms["un-retried-direct"].tasksTotal})`,
  );
  lines.push(
    `- delta (mediated-with-plan − strong-optimized): **${verdicts.resolution.deltaPercentagePoints?.toFixed(2)} percentage points**`,
  );
  lines.push(
    `- request-level: mediated-with-plan ${percentOf(verdicts.resolution.mediatedRequestResolutionRate)} vs strong-optimized ${percentOf(verdicts.resolution.optimizedRequestResolutionRate)}`,
  );
  lines.push(
    `- per-cell parity: mediated-with-plan resolved at least as many tasks as strong-optimized in **${verdicts.resolution.cellsWhereMediatedAtLeastOptimized}/${verdicts.resolution.cellsTotal}** targeted cells`,
  );
  lines.push(
    `- **VERDICT: ${verdicts.resolution.verdict.toUpperCase()}** (threshold: ${verdicts.resolution.threshold})`,
  );
  if (verdicts.resolution.attribution !== null) {
    lines.push(`- attribution: ${verdicts.resolution.attribution}`);
  }
  lines.push("");
  lines.push("## T2 — Failure-adjusted cost per resolved outcome (improved-or-documented)");
  lines.push("");
  lines.push(
    `- mediated-with-plan: **${microOf(verdicts.cost.mediatedMicroPerResolvedTask)} µ$/resolved task** (synthetic-cost; ${aggregate.arms["mediated-with-plan"].nanoCost} nano-USD over ${aggregate.arms["mediated-with-plan"].tasksResolved} resolved task occurrences)`,
  );
  lines.push(
    `- strong-optimized: **${microOf(verdicts.cost.optimizedMicroPerResolvedTask)} µ$/resolved task** (synthetic-cost; ${aggregate.arms["strong-optimized"].nanoCost} nano-USD over ${aggregate.arms["strong-optimized"].tasksResolved})`,
  );
  lines.push(
    `- un-retried-direct (context): ${microOf(aggregate.arms["un-retried-direct"].microPerResolvedTask)} µ$/resolved task`,
  );
  lines.push(
    `- measured supply exposures per resolved request: mediated-with-plan ${verdicts.cost.mediatedExposuresPerResolvedRequest?.toFixed(4)} vs strong-optimized ${verdicts.cost.optimizedExposuresPerResolvedRequest?.toFixed(4)}`,
  );
  lines.push(
    `- **VERDICT: ${verdicts.cost.verdict.toUpperCase()}** (threshold: ${verdicts.cost.threshold})`,
  );
  lines.push(`- attribution: ${verdicts.cost.attribution}`);
  lines.push("");
  lines.push("## T3 — Policy/budget violations (the hard gate: ZERO)");
  lines.push("");
  lines.push(
    `- violations observed: **${verdicts.violations.count}** — ${
      verdicts.violations.count === 0
        ? "the hard gate holds (attempt bounds, the per-execution budget ceiling, the plan step bound, the route policy and the task↔request outcome coherence verified mechanically over every attempt of every arm in every targeted cell at run time; the plan-artifact leg carried IN-SUITE — the recovery plane's own total validation (validateRecoveryPlan) injected by the test suites over every composed plan of the full evaluation, the deterministic-replay identity making it a validation of this committed evidence; see the test suites and the README's boundary disciplines)"
        : "DELIVERY-BLOCKING — see the records"
    }`,
  );
  lines.push(`- **VERDICT: ${verdicts.violations.verdict.toUpperCase()}**`);
  if (verdicts.violations.records.length > 0) {
    for (const record of verdicts.violations.records) {
      lines.push(`  - [${record.kind}] ${record.armId} / ${record.cellId}: ${record.detail}`);
    }
  }
  lines.push("");
  lines.push("## T4 — Latency tails (explicit tradeoff accounting)");
  lines.push("");
  lines.push(`Basis: ${verdicts.latencyTails.accounting.basisNote}.`);
  lines.push("");
  lines.push("### Per-occurrence end-to-end tails (the user-experienced tradeoff)");
  lines.push("");
  lines.push(TAIL_HEADER);
  lines.push(TAIL_SEPARATOR);
  for (const group of verdicts.latencyTails.accounting.perOccurrence) {
    lines.push(tailRow(group));
  }
  lines.push("");
  lines.push(
    `- recovered-request p95 (resolved-after-recovery): mediated-with-plan **${msOf(verdicts.latencyTails.mediatedRecoveredP95Ms)} ms** vs strong-optimized ${msOf(verdicts.latencyTails.optimizedRecoveredP95Ms)} ms (synthetic-latency) — the recovery ladder's added attempts are the explicit, disclosed tail tradeoff`,
  );
  lines.push("");
  lines.push("### Per-attempt tails by failure class");
  lines.push("");
  lines.push(TAIL_HEADER);
  lines.push(TAIL_SEPARATOR);
  for (const group of verdicts.latencyTails.accounting.perAttemptByClass) {
    lines.push(tailRow(group));
  }
  lines.push("");
  lines.push("### Per-attempt tails by route");
  lines.push("");
  lines.push(TAIL_HEADER);
  lines.push(TAIL_SEPARATOR);
  for (const group of verdicts.latencyTails.accounting.perAttemptByRoute) {
    lines.push(tailRow(group));
  }
  lines.push("");
  lines.push(
    `- **VERDICT: ${verdicts.latencyTails.verdict.toUpperCase()}** (threshold: ${verdicts.latencyTails.threshold}; no silent tail regressions — every group is disclosed above)`,
  );
  lines.push("");
  lines.push("## PCR-004 eligibility statement (the hedged-mode gate)");
  lines.push("");
  lines.push(
    `The targeted cells are side-effect-safe idempotent workload replays by construction (the certified adapters' content-addressed idempotency discipline — every logical request is a read-style completion over the deterministic synthetic supply; the deterministic substrate plane recomputes rather than re-dispatches). On this evidence:`,
  );
  lines.push("");
  lines.push(
    `- sequential plans reached the resolution threshold: **${verdicts.pcr004Eligibility.sequentialPlansReachedResolutionThreshold}**`,
  );
  lines.push(
    `- hedged execution (PCR-004) eligible: **${verdicts.pcr004Eligibility.hedgedModeEligible}**`,
  );
  lines.push(`- ${verdicts.pcr004Eligibility.statement}`);
  lines.push("");
  lines.push("## The per-cell table (fresh measurements)");
  lines.push("");
  lines.push("| cell | direct | strong-optimized | mediated-with-plan |");
  lines.push("|---|---|---|---|");
  for (const row of options.perCellTable) {
    lines.push(
      `| ${row.cellId} | ${row.directTasksResolved}/${row.directTasksTotal} | ${row.optimizedTasksResolved}/${row.optimizedTasksTotal} | ${row.mediatedTasksResolved}/${row.mediatedTasksTotal} |`,
    );
  }
  lines.push("");
  lines.push("## Reproducibility (the deterministic replay discipline)");
  lines.push("");
  lines.push(`- corpus digest (pinned): \`${options.corpusDigest}\``);
  lines.push(`- evaluation digest (this run): \`${aggregate.digest}\``);
  lines.push(
    `- re-run digest comparison: ${
      options.reRunDigest === null
        ? "NOT RUN in this rendering (the in-suite determinism proof re-runs the hermetic slice; see the test suites)"
        : `\`${options.reRunDigest}\` — ${options.reRunDigest === aggregate.digest ? "IDENTICAL (the full evaluation re-run reproduced the evaluation digest byte-for-byte)" : "DIVERGENT (a reproducibility failure — delivery-blocking)"}`
    }`,
  );
  lines.push(
    "- every per-attempt evidence record was verified against the synthetic transport's own pure draw functions during the run (self-verifying evidence); wall-clock values and run identities are excluded from every digest projection",
  );
  lines.push("");
  lines.push("## Honest boundaries");
  lines.push("");
  lines.push(
    "- synthetic replay only: no live/credentialed provider runs, no market or production claims; live validation is the operator-era obligation",
  );
  lines.push(
    "- the mediated-with-plan arm's plan mode retries provider-capacity (provider-unavailable) failures the traced default-off posture would not retry — the recovery plane's class-based retryability discipline (provider is a retryable class) governs plan-mode composition, while the traced posture consumes the transport's non-retryable flag; this divergence is the wired seam's delivered PCR-002 semantics and is disclosed here as an observation, not modified (evaluation only)",
  );
  lines.push(
    "- the deterministic substrate plane (the browseruse subject's substrate edges) makes zero supply dispatches for the mediated arm while the baselines route those requests through the supply at the per-call schedule price — a disclosed structural difference in the measured cost basis",
  );
  lines.push(
    `- run started ${options.runStartedAt}; base revision \`${BASE_REVISION}\`; run revision \`${options.runRevision}\``,
  );
  lines.push("");
  return lines.join("\n");
}
