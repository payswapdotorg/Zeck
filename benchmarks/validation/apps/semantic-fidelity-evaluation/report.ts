/**
 * The threshold report renderer (PCS-004 — the PCR-003
 * `threshold-report.md` pattern).
 *
 * DECLARED-BEFORE / MEASURED-AFTER (the pattern's law): the report
 * renders the thresholds EXACTLY as committed with the corpus
 * (corpus.ts THRESHOLDS — declared BEFORE the run) against the
 * measured records, with every verdict DERIVED mechanically and every
 * miss carrying its attribution (a threshold miss with honest
 * attribution is a VALID delivery — the truth discipline).
 *
 * HONEST LABELS on every number: synthetic-supply /
 * synthetic-semantic-supply / no-cost-no-latency-measurements — never
 * a live-provider claim; live credentialed semantic-quality
 * validation remains the operator-era obligation, never backfilled.
 */

import { SYNTHETIC_LABELS, THRESHOLDS } from "./corpus";
import type { EvaluationAggregate, EvaluationResult } from "./driver";
import { CONTINUE_EDGE_CONTEXT } from "./replay";

/** The fraction as a percentage string (deterministic rendering). */
function pct(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "n/a";
  }
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

/** Render the threshold verdict line (declared → measured → verdict). */
function verdictLine(aggregate: EvaluationAggregate, key: string, declared: string): string {
  const verdict = aggregate.verdicts[key];
  if (verdict === undefined) {
    return `- ${key}: NOT DERIVED (the driver did not derive this verdict — an honest gap, never a guess)`;
  }
  const attribution =
    verdict.verdict === "met" ? "" : ` — attribution: ${verdict.attribution ?? "unavailable"}`;
  return `- declared: ${declared} → verdict: **${verdict.verdict.toUpperCase()}**${attribution}`;
}

/** Render the full threshold report (the committed artifact). */
export function renderThresholdReport(input: {
  readonly result: EvaluationResult;
  readonly runRevision: string;
  readonly runStartedAt: string;
  readonly reRunDigest: string | null;
}): string {
  const { result, runRevision, runStartedAt, reRunDigest } = input;
  const aggregate = result.aggregate;
  const lines: string[] = [];

  lines.push("# PCS-004 Threshold Report — semantic-fidelity-evaluation");
  lines.push("");
  lines.push(
    "The P2 program's semantic-fidelity evaluation (ACR-009 §6, work order PCS-004): the quality fixtures (the measurable distinction between model-backed semantic quality and deterministic lexical/hash substitutes), the negative controls (the hard gate — a task requiring semantic retrieval must NOT pass merely because a deterministic vector is produced), the differentiated evidence (the mechanical discriminator over the typed facts) and the honest replay of the PPR-025/PPR-026 embeddings lines under the gated configuration. All numbers are fresh measurements of THIS evaluation at run revision `" +
      runRevision +
      "`; the recorded P2-FIX-era results are quoted verbatim and never relabeled.",
  );
  lines.push("");
  lines.push("## Honest labels (carried on every number)");
  lines.push("");
  lines.push(`- supply: ${SYNTHETIC_LABELS.supply}`);
  lines.push(`- semantic arm: ${SYNTHETIC_LABELS.semanticSupply}`);
  lines.push(`- measurements: ${SYNTHETIC_LABELS.measurement}`);
  lines.push(
    "- a threshold miss with honest attribution is a valid delivery (the program's truth discipline); live/credentialed validation is the operator-era obligation and is never backfilled from synthetic runs",
  );
  lines.push("");
  lines.push("## The two representation arms (the pre-registered comparison)");
  lines.push("");
  lines.push(
    "- **deterministic-substitute** — the REAL PPR-025 Zeck-side executor (`compat/openwebui/harness/embeddings.ts`, imported read-only): SHA-256-signed feature hashing of lowercased unigram+bigram surface tokens, sublinear TF, L2-normalized, 512 fixed dimensions — the era's recorded execution representation (synthetic-supply; never a model rail)",
  );
  lines.push(
    "- **synthetic-semantic-supply** — concept normalization through the committed curated dictionaries (synonym/translation/sense maps — the synthetic supply of the semantic knowledge a model-backed embedding service would bring to this corpus) followed by the SAME feature-hash arithmetic (same tokenizer, dimensions, weighting, normalization): the declared upper bound of model-backed semantic retrieval ON THIS CURATED CORPUS (synthetic-semantic-supply — never a live model measurement)",
  );
  lines.push("");
  lines.push("## T1 — The quality fixtures (the measurable distinction)");
  lines.push("");
  lines.push(
    "| fixture group | fixtures | semantic arm top-1 (synthetic-semantic-supply) | substitute top-1 (synthetic-supply) | distinct |",
  );
  lines.push("|---|---:|---:|---:|---|");
  for (const [group, counts] of Object.entries(aggregate.fixtures.perGroup)) {
    lines.push(
      `| ${group} | ${counts.total} | ${counts.semanticTop1}/${counts.total} (${pct(counts.semanticTop1, counts.total)}) | ${counts.substituteTop1}/${counts.total} (${pct(counts.substituteTop1, counts.total)}) | ${counts.substituteTop1 < counts.semanticTop1 ? "yes" : "NO"} |`,
    );
  }
  const overall = aggregate.fixtures.overall;
  lines.push(
    `| **overall** | ${overall.total} | ${overall.semanticTop1}/${overall.total} (${pct(overall.semanticTop1, overall.total)}) | ${overall.substituteTop1}/${overall.total} (${pct(overall.substituteTop1, overall.total)}) | ${overall.substituteTop1 < overall.semanticTop1 ? "yes" : "NO"} |`,
  );
  lines.push("");
  lines.push(
    "The construction law (verified mechanically in-suite against the real executor): every fixture's distractor shares MORE discriminating surface lexical tokens with the query than the ground-truth target does — so the lexical/hash substitute ranks the distractor first (the honest failure mode), while the ground-truth target is the paraphrase/translation/sense-family neighbor (the curated semantic relation). The measured distinction is exactly the curated semantic knowledge a model-backed representation would supply.",
  );
  lines.push("");
  lines.push(`### Verdicts`);
  lines.push("");
  lines.push(
    verdictLine(
      aggregate,
      "t1aSemanticTop1PerGroup",
      `the synthetic semantic arm retrieves the ground truth first on ${THRESHOLDS.t1aSemanticTop1PerGroup * 100}% of every group`,
    ),
  );
  lines.push(
    verdictLine(
      aggregate,
      "t1bSubstituteStrictlyBelowPerGroup",
      "the deterministic substitute is strictly below the semantic arm on every group",
    ),
  );
  lines.push("");
  lines.push("## T2 — The negative controls (the hard gate)");
  lines.push("");
  lines.push(
    `- hard-gate controls (tasks declaring \`requires-semantic-retrieval-quality\` offered ONLY the deterministic substitute): **${aggregate.controls.hardGateTotal}**`,
  );
  lines.push(
    `- failed closed with the typed reason \`semantic-quality-contract-forbids-substitute\`: **${aggregate.controls.hardGateFailedClosedWithTypedReason}/${aggregate.controls.hardGateTotal}**`,
  );
  lines.push(
    `- admitted (a typed pass on the substitute): **${aggregate.controls.hardGateAdmitted}** — any admission is delivery-blocking`,
  );
  lines.push(
    `- the discriminating matrix (the gate's precision): **${aggregate.controls.discriminatingAsExpected}/${aggregate.controls.discriminatingTotal}** controls produced their expected verdicts (a declared contract is satisfiable by a model-backed representation; a substitute not on the plan does not trip it; the explicit absent spelling and the undeclared spelling permit the substitute with the disclosure recorded; malformed contracts fail closed; an already-inadmissible candidate is returned unchanged — the invariant-13 composition)`,
  );
  lines.push("");
  lines.push(
    "Every control's verdict is asserted mechanically IN-SUITE against the REAL planner gate (`applySemanticQualityGating` from `src/modules/planning/public`, driven by `tests/unit/validation/pcs-004-*.test.ts`) — the local projection the run uses (gate.ts) is pinned verdict-for-verdict against it; a fabricated pass is unrepresentable.",
  );
  lines.push("");
  lines.push(verdictLine(aggregate, "t2HardGateFailClosed", "100% fail closed; 0 admitted"));
  lines.push("");
  lines.push("## T3 — The differentiated evidence (the mechanical discriminator)");
  lines.push("");
  const disc = aggregate.discrimination;
  lines.push(
    `- emitted representation records: **${disc.recordsWithRepresentations}** (every record carries its typed SemanticFidelityFacts)`,
  );
  lines.push(
    `- separated by the mechanical discriminator (reading ONLY the typed facts, never prose): **${disc.separated}/${disc.recordsWithRepresentations}** (${pct(disc.separated, disc.recordsWithRepresentations)})`,
  );
  lines.push(
    `- separated as \`semantic-model-backed\`: **${disc.semanticModelBacked}**; as \`deterministic-substitute\`: **${disc.deterministicSubstitute}** (both kinds present — the closed two-kind vocabulary's both members exercised)`,
  );
  lines.push(`- rejected by the discriminator (malformed/incoherent shapes): **${disc.rejected}**`);
  lines.push("");
  lines.push(
    "The discriminator's tamper-discriminations (a flipped representation kind, a substitute fact without its substitute identity, a model-backed fact claiming one, an unknown kind) are each REJECTED with a typed reason — proven in-suite over the emitted record corpus.",
  );
  lines.push("");
  lines.push(
    verdictLine(
      aggregate,
      "t3DiscriminatorCoverage",
      "the discriminator separates 100% of emitted records, both kinds present",
    ),
  );
  lines.push("");
  lines.push("## T4 — The replay of the PPR-025/PPR-026 embeddings lines");
  lines.push("");
  lines.push(
    "| replay line | era work order | era task | era target top-1 under the substitute (contract-absent) | gated arm (contract-declared) |",
  );
  lines.push("|---|---|---|---|---|");
  for (const record of result.replayRecords) {
    lines.push(
      `| ${record.lineId} | ${record.eraWorkOrder} | ${record.eraTaskId} | ${record.absentArm.retrieval.resolved ? "yes (the era's lexical-overlap basis holds)" : `NO — ${record.absentArm.retrieval.top1Id}`} | ${record.gatedArm.gate.verdict === "inadmissible" && record.gatedArm.gate.reason === "semantic-quality-contract-forbids-substitute" ? "FAIL CLOSED (typed reason; no vector produced for the task's satisfaction)" : "NOT CLOSED — delivery-blocking"} |`,
    );
  }
  lines.push("");
  lines.push(
    `- the era's recorded limitation, quoted VERBATIM from the committed evidence records (never relabeled): "the authorized supply exposes no embeddings endpoint (probed live: POST /embeddings → 404); the delegated embeddings edge is executed by the Zeck-side DETERMINISTIC lexical-hash strategy (real, deterministic, mechanically verified; strategyClass deterministic-embeddings, modelCalls 0) — a model-backed embeddings rail remains an operator-provider boundary" (area: embeddings execution representation; owner: Lead)`,
  );
  lines.push(`- context (quoted, not re-run): ${CONTINUE_EDGE_CONTEXT}`);
  lines.push(
    "- the replay's new facts are ADDITIVE: the era's records stay exactly as recorded; under the gated configuration the SAME tasks now carry the typed inadmissibility verdict and the unmet-no-admissible-semantic-representation disclosure (what remains unavailable: semantic-model-backed)",
  );
  lines.push("");
  lines.push(
    verdictLine(
      aggregate,
      "t4ReplayLinesAllHold",
      "every line: the era target ranks first under the substitute AND the gated arm fails closed",
    ),
  );
  lines.push("");
  lines.push("## T5 — Reproducibility (the deterministic replay discipline)");
  lines.push("");
  lines.push(`- corpus digest (pinned): \`${result.corpusDigest}\``);
  lines.push(`- evaluation digest (this run): \`${result.digest}\``);
  lines.push(
    `- re-run digest comparison: \`${reRunDigest ?? "NOT RUN (single mode)"}\` — ${reRunDigest === null ? "NOT RUN" : reRunDigest === result.digest ? "IDENTICAL (the re-run reproduced the evaluation digest byte-for-byte)" : "DIVERGENT (reproducibility failure)"}`,
  );
  lines.push(
    "- wall-clock values and run identities are excluded from every digest projection; the in-suite determinism proof re-runs the complete evaluation and compares digests",
  );
  lines.push("");
  lines.push("## Honest boundaries");
  lines.push("");
  lines.push(
    "- synthetic replay only: no live/credentialed provider runs, no market or production claims; live validation is the operator-era obligation",
  );
  lines.push(
    "- the synthetic semantic arm is the curated-knowledge upper bound ON THIS CORPUS, not a live model measurement — the fixture distinction proves the SUBSTITUTION GAP (what the lexical/hash substitute cannot do that semantic structure can), never live model quality",
  );
  lines.push(
    "- the evaluation consumes the PCS-002/PCS-003 planes through app-local mirrors pinned byte-for-byte in-suite against the real planes (the customer boundary — VAL-002 AC7 — forbids `src/**` imports from the application tree; the canonical-serializer precedent)",
  );
  lines.push(
    "- the replay's era material is imported read-only from the compat corpus modules and the committed evidence records; no compat file is modified",
  );
  lines.push(`- run started ${runStartedAt}; run revision \`${runRevision}\``);
  lines.push("");
  return lines.join("\n");
}
