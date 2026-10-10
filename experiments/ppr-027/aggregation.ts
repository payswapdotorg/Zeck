/**
 * PPR-027 — the portfolio aggregation: read the NINE delivered certified
 * evidence records (deploy/evidence/ppr-018.json .. ppr-026.json — the
 * frozen delivered artifacts) and aggregate their observed measurements
 * into the cross-application comparison the Completion section demands:
 * which applications are AI_EXECUTION_COMPLETE, which material edges
 * remain blocked/bypassed, and the gap taxonomy (implementation gap /
 * public-contract gap / operator-provider boundary / architecture-gap
 * candidate) per the records' own vocabulary.
 *
 * DEFENSIVE EXTRACTION: the nine records were delivered across the
 * program's evolution (PPR-018 predates the PPR-018A measurement schema;
 * PPR-021 is a Lead-assembled narrative reconstruction) — every field is
 * located wherever the record actually carries it, and absence is
 * recorded as an honest null, never guessed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBJECTS } from "./config";

const REPO_ROOT = join(new URL(".", import.meta.url).pathname, "..", "..");

/** One record's extracted portfolio facts. */
export interface PortfolioRecordFacts {
  readonly workOrder: string;
  readonly subjectId: string;
  readonly title: string;
  readonly date: string | null;
  readonly recordId: string | null;
  readonly recordBasis: string | null;
  readonly upstreamRevision: string | null;
  readonly integrationRevision: string | null;
  readonly declaredEdges: number | null;
  readonly delegatedEdges: number | null;
  readonly notRunEdges: number | null;
  readonly totalExecutionIds: number | null;
  readonly derivedStatus: string | null;
  readonly ruleResults: readonly { readonly ruleId: string; readonly satisfied: boolean }[];
  readonly finalCertification: string | null;
  readonly corpusOutcomes: {
    readonly attempts: number | null;
    readonly successes: number | null;
  };
  readonly measurementsBlock: boolean;
  readonly measuredDimensions: readonly string[];
  readonly comparisonEntries: readonly {
    readonly baseline: string;
    readonly basis: string;
    readonly statement: string;
  }[];
  readonly dormantEdgeDisclosures: number | null;
  readonly nonAiOperations: number | null;
  readonly limitations: number | null;
  readonly notRunCauses: number | null;
  readonly discoveredInventoryEdges: number | null;
  readonly gapClassificationCounts: {
    readonly implementationGap: number;
    readonly publicContractGap: number;
    readonly operatorProviderBoundary: number;
    readonly architectureGapCandidate: number;
  };
  readonly notes: readonly string[];
}

function countMatches(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Extract one record's facts (defensively — wherever the record carries them). */
export function extractPortfolioFacts(filePath: string, subjectId: string): PortfolioRecordFacts {
  const raw = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const notes: string[] = [];
  if (raw === "") {
    return {
      workOrder: "unknown",
      subjectId,
      title: "RECORD ABSENT",
      date: null,
      recordId: null,
      recordBasis: null,
      upstreamRevision: null,
      integrationRevision: null,
      declaredEdges: null,
      delegatedEdges: null,
      notRunEdges: null,
      totalExecutionIds: null,
      derivedStatus: null,
      ruleResults: [],
      finalCertification: null,
      corpusOutcomes: { attempts: null, successes: null },
      measurementsBlock: false,
      measuredDimensions: [],
      comparisonEntries: [],
      dormantEdgeDisclosures: null,
      nonAiOperations: null,
      limitations: null,
      notRunCauses: null,
      discoveredInventoryEdges: null,
      gapClassificationCounts: {
        implementationGap: 0,
        publicContractGap: 0,
        operatorProviderBoundary: 0,
        architectureGapCandidate: 0,
      },
      notes: [`the evidence record file ${filePath} is absent`],
    };
  }
  const record = JSON.parse(raw) as Json;
  const evidenceRecord = asObject(record.evidenceRecord);
  const derived = asObject(record.derivedAssessment);
  const battery = asObject(record.battery);
  const finalCertification = asObject(record.finalCertification);
  const pinned = asObject(evidenceRecord?.pinnedApplication);
  const pin = asObject(pinned?.pin);
  const graph = asObject(evidenceRecord?.graph);
  const discovered = asObject(
    evidenceRecord?.discoveredInventory ?? record.discoveredInventory ?? null,
  );

  const dispositions = asArray(evidenceRecord?.dispositions);
  const delegatedEdges = dispositions.filter(
    (entry) => asObject(entry)?.disposition === "delegated",
  ).length;
  const notRunEdges = dispositions.filter((entry) => {
    const kind = asObject(entry)?.disposition;
    return kind === "not-run" || kind === "blocked" || kind === "bypassed";
  }).length;
  const totalExecutionIds = dispositions.reduce((sum: number, entry) => {
    const object = asObject(entry);
    const ids = asArray(object?.zeckExecutionIds);
    return sum + ids.length;
  }, 0);

  const ruleResults = asArray(derived?.ruleResults).map((entry) => {
    const object = asObject(entry);
    return {
      ruleId: String(object?.ruleId ?? "unknown"),
      satisfied: object?.satisfied === true,
    };
  });

  // The measurements block: top-level (PPR-025/026) or battery-nested (PPR-024).
  const measurementsObject = asObject(record.measurements) ?? asObject(battery?.measurements);
  const measurementsBlock = measurementsObject !== null;
  const measuredDimensions = measurementsBlock
    ? asArray(measurementsObject?.entries)
        .map((entry) => asObject(entry))
        .filter((entry): entry is Json => entry !== null)
        .map((entry) => String(entry.dimension ?? "unknown"))
    : [];

  const comparisonEntries = asArray(evidenceRecord?.comparison).map((entry) => {
    const object = asObject(entry);
    return {
      baseline: String(object?.baseline ?? object?.kind ?? "unnamed"),
      basis: String(object?.basis ?? "unknown"),
      statement: String(object?.statement ?? "").slice(0, 400),
    };
  });

  // Corpus outcomes: from the measurements block when present, else from
  // the runtime evidence / battery narrative (recorded with a note).
  let attempts: number | null = null;
  let successes: number | null = null;
  if (measurementsBlock) {
    for (const entry of asArray(measurementsObject?.entries)) {
      const object = asObject(entry);
      if (object?.dimension === "outcome-success") {
        attempts = typeof object.attempts === "number" ? object.attempts : null;
        successes = typeof object.successes === "number" ? object.successes : null;
      }
    }
  }
  if (attempts === null || successes === null) {
    const corpusNarrative = asArray(battery?.corpus);
    if (corpusNarrative.length > 0) {
      attempts = corpusNarrative.length;
      successes = corpusNarrative.filter(
        (entry) => asObject(entry)?.resolved === true || asObject(entry)?.ok === true,
      ).length;
      notes.push(
        "corpus outcomes derived from the battery corpus entries (the record predates the 13-dimension measurement schema)",
      );
    }
  }

  const dormant = asArray(
    evidenceRecord?.dormantEdgeDisclosures ?? record.dormantEdgeDisclosures,
  ).length;
  const nonAi = asArray(evidenceRecord?.nonAiOperations ?? record.nonAiOperations).length;
  const limitations = asArray(evidenceRecord?.limitations ?? record.limitations).length;
  const notRunCauses = asArray(evidenceRecord?.notRunCauses ?? record.notRunCauses).length;

  const lower = raw.toLowerCase();
  const gapClassificationCounts = {
    implementationGap: countMatches(lower, "implementation gap"),
    publicContractGap: countMatches(lower, "public-contract gap"),
    operatorProviderBoundary: countMatches(lower, "operator-provider boundary"),
    architectureGapCandidate: countMatches(lower, "architecture-gap candidate"),
  };

  return {
    workOrder: String(record.workOrder ?? "unknown"),
    subjectId,
    title: String(record.title ?? "untitled"),
    date: typeof record.date === "string" ? record.date : null,
    recordId:
      typeof evidenceRecord?.recordId === "string" ? (evidenceRecord.recordId as string) : null,
    recordBasis:
      typeof evidenceRecord?.recordBasis === "string"
        ? (evidenceRecord.recordBasis as string)
        : null,
    upstreamRevision:
      pin !== null && typeof pin.upstreamRevision === "string" ? pin.upstreamRevision : null,
    integrationRevision:
      pin !== null && typeof pin.integrationRevision === "string" ? pin.integrationRevision : null,
    declaredEdges: graph === null ? null : asArray(graph.edges).length,
    delegatedEdges,
    notRunEdges,
    totalExecutionIds,
    derivedStatus: typeof derived?.status === "string" ? derived.status : null,
    ruleResults,
    finalCertification:
      finalCertification === null
        ? null
        : typeof finalCertification.status === "string"
          ? finalCertification.status
          : "present",
    corpusOutcomes: { attempts, successes },
    measurementsBlock,
    measuredDimensions,
    comparisonEntries,
    dormantEdgeDisclosures: dormant === 0 ? null : dormant,
    nonAiOperations: nonAi === 0 ? null : nonAi,
    limitations: limitations === 0 ? null : limitations,
    notRunCauses: notRunCauses === 0 ? null : notRunCauses,
    discoveredInventoryEdges: discovered === null ? null : asArray(discovered.edges).length,
    gapClassificationCounts,
    notes,
  };
}

/** Aggregate all nine delivered records (the portfolio table). */
export function aggregatePortfolio(): {
  readonly records: readonly PortfolioRecordFacts[];
  readonly tallies: {
    readonly aiExecutionComplete: number;
    readonly partial: number;
    readonly blocked: number;
    readonly bypassDetected: number;
    readonly gapClassifications: {
      readonly implementationGap: number;
      readonly publicContractGap: number;
      readonly operatorProviderBoundary: number;
      readonly architectureGapCandidate: number;
    };
    readonly recordsWithMeasurementsBlock: number;
  };
} {
  const records = SUBJECTS.map((subject) =>
    extractPortfolioFacts(
      join(REPO_ROOT, "deploy", "evidence", `${subject.evidenceRecord.split("/").pop()}`),
      subject.subjectId,
    ),
  );
  const tallies = {
    aiExecutionComplete: records.filter(
      (record) => record.derivedStatus === "AI_EXECUTION_COMPLETE",
    ).length,
    partial: records.filter((record) => record.derivedStatus === "PARTIAL").length,
    blocked: records.filter((record) => record.derivedStatus === "BLOCKED").length,
    bypassDetected: records.filter((record) => record.derivedStatus === "BYPASS_DETECTED").length,
    gapClassifications: records.reduce(
      (sum, record) => ({
        implementationGap: sum.implementationGap + record.gapClassificationCounts.implementationGap,
        publicContractGap: sum.publicContractGap + record.gapClassificationCounts.publicContractGap,
        operatorProviderBoundary:
          sum.operatorProviderBoundary + record.gapClassificationCounts.operatorProviderBoundary,
        architectureGapCandidate:
          sum.architectureGapCandidate + record.gapClassificationCounts.architectureGapCandidate,
      }),
      {
        implementationGap: 0,
        publicContractGap: 0,
        operatorProviderBoundary: 0,
        architectureGapCandidate: 0,
      },
    ),
    recordsWithMeasurementsBlock: records.filter((record) => record.measurementsBlock).length,
  };
  return { records, tallies };
}
