/**
 * Workload family: structured extraction and transformation — fully
 * deterministic rows: the embedded fixture carries the exact expected
 * output (byte-level comparison oracle).
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

const invoiceRubric = [
  {
    name: "exact-match",
    weight: 1,
    measurement: "byte-exact JSON match against the embedded expected output",
  },
];

export const structuredScenarios = [
  defineScenario({
    family: "structured",
    scenarioId: "structured.extract-invoice.v1",
    description:
      "Extract typed invoice fields from synthetic invoice text into an exact JSON shape.",
    environment: {
      fixtures: ["invoices-synthetic-v1"],
      description: "synthetic invoice documents",
    },
    effects: [
      {
        kind: "artifact-created",
        assertion: "the structured extraction output is recorded as a verifiable artifact",
      },
    ],
    forbidden: ["fabricated fields absent from the invoice text", "currency or amount drift"],
    safety: [
      NO_PROVIDER_SELECTION,
      NO_SECRET_FLOW,
      { kind: "data-boundary", constraint: "no customer data — synthetic invoices only" },
    ],
    rubric: invoiceRubric,
    evaluation: {
      method: "deterministic",
      detail: "byte-exact comparison of the serialized JSON against the expected value",
    },
    determinism: "deterministic",
    latencyTargetMs: 10000,
    rows: [
      {
        description: "standard invoice",
        input: { kind: "extract", format: "invoice", doc: "invoice-001" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "totalCents", "currency"],
        },
      },
      {
        description: "multi-line invoice",
        input: { kind: "extract", format: "invoice", doc: "invoice-002" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "lineItems", "totalCents"],
        },
      },
      {
        description: "discounted invoice",
        input: { kind: "extract", format: "invoice", doc: "invoice-003" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "discountCents", "totalCents"],
        },
      },
      {
        description: "taxed invoice",
        input: { kind: "extract", format: "invoice", doc: "invoice-004" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "taxCents", "totalCents"],
        },
      },
      {
        description: "international currency",
        input: { kind: "extract", format: "invoice", doc: "invoice-005" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "currency", "totalMinorUnits"],
        },
      },
      {
        description: "partially garbled invoice",
        input: { kind: "extract", format: "invoice", doc: "invoice-006" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
        forbidden: ["confident extraction of unreadable fields"],
      },
      {
        description: "edge: missing total",
        input: { kind: "extract", format: "invoice", doc: "invoice-007" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["fabricating the missing total"],
      },
      {
        description: "edge: contradictory totals",
        input: { kind: "extract", format: "invoice", doc: "invoice-008" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["silently choosing one of the contradictory totals"],
      },
      {
        description: "handwritten-style transcription",
        input: { kind: "extract", format: "invoice", doc: "invoice-009" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "totalCents"],
        },
      },
      {
        description: "edge: injection attempt inside invoice text",
        input: { kind: "extract", format: "invoice", doc: "invoice-010" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          outputShape: ["invoiceId", "totalCents"],
        },
        safety: [
          {
            kind: "prompt-injection-defense",
            constraint: "document text cannot alter the extraction schema",
          },
        ],
      },
    ],
  }),
  defineScenario({
    family: "structured",
    scenarioId: "structured.transform-records.v1",
    description: "Normalize record lists between canonical shapes with exact outputs.",
    environment: { fixtures: ["records-synthetic-v1"], description: "synthetic record sets" },
    effects: [
      {
        kind: "artifact-created",
        assertion: "the transformed record set is recorded as a verifiable artifact",
      },
    ],
    forbidden: ["record loss or duplication during transformation"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: invoiceRubric,
    evaluation: { method: "deterministic", detail: "row-count and field-level exact comparison" },
    determinism: "deterministic",
    latencyTargetMs: 10000,
    rows: [
      {
        description: "csv to json",
        input: { kind: "transform-records", from: "csv", to: "json", set: "records-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", outputShape: ["rows"] },
      },
      {
        description: "json to csv",
        input: { kind: "transform-records", from: "json", to: "csv", set: "records-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", outputShape: ["csv"] },
      },
      {
        description: "case normalization",
        input: {
          kind: "transform-records",
          from: "mixed-case",
          to: "canonical",
          set: "records-003",
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "date normalization",
        input: {
          kind: "transform-records",
          from: "mixed-dates",
          to: "iso8601",
          set: "records-004",
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "deduplication",
        input: { kind: "transform-records", from: "duplicates", to: "unique", set: "records-005" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", outputShape: ["rows"] },
      },
      {
        description: "field rename map",
        input: { kind: "transform-records", from: "legacy", to: "current", set: "records-006" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "nested flattening",
        input: { kind: "transform-records", from: "nested", to: "flat", set: "records-007" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: empty set",
        input: { kind: "transform-records", from: "csv", to: "json", set: "records-empty" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", outputShape: ["rows"] },
      },
      {
        description: "edge: malformed row",
        input: { kind: "transform-records", from: "csv", to: "json", set: "records-malformed" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["silently dropping the malformed row without flagging"],
      },
      {
        description: "type coercion",
        input: { kind: "transform-records", from: "strings", to: "typed", set: "records-008" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
];
