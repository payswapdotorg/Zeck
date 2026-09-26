/**
 * PPR-017 — the exact-revision binding test (the work order:
 * "exact-revision binding test (mismatched/absent pin rejected)").
 *
 * A compatibility claim is only meaningful against EXACT revisions
 * (the proof program's battery step 1). This test pins the three
 * binding surfaces where a revision mismatch must be a NAMED defect,
 * never a guess:
 *  1. the pin itself (both revisions mandatory — absent/blank rejected
 *     at validation);
 *  2. the demo registry binding: an entry whose reproducibility pins
 *     disagree with the bound record's pins is a revision-mismatch
 *     resolution, never a rendered demo (the entry describes a
 *     different revision than the evidence proves);
 *  3. the evidence record construction: a record with a malformed pin
 *     fails closed (buildRecord rejects it), so a proof cannot even be
 *     RECORDED without exact pins.
 */

import { describe, expect, test } from "vitest";
import {
  type CompatibilityEvidenceRecord,
  CompatibilityFlowError,
  createCompatibilityService,
  type DemoMirrorEntry,
  EXAMPLE_CODING_ASSISTANT_RECORD,
  resolveDemoMirrorEntry,
  revisionPinsEqual,
  validateRevisionPin,
} from "../../../src/integrations/compatibility/public";

const BOUND_RECORD: CompatibilityEvidenceRecord = EXAMPLE_CODING_ASSISTANT_RECORD;

function entryWithPins(
  pinnedUpstreamRevision: string,
  integrationRevision: string,
): DemoMirrorEntry {
  return {
    demoId: "revision-binding-test-demo",
    evidenceRecordId: BOUND_RECORD.recordId,
    representativeTask: {
      title: "A representative task",
      description: "The task a certified run would replay.",
    },
    runBinding: { kind: "none" },
    reproducibility: { instructions: "test entry", pinnedUpstreamRevision, integrationRevision },
    warnings: [],
  };
}

describe("exact-revision binding", () => {
  test("an absent or blank pin is rejected at validation (both revisions mandatory)", () => {
    expect(
      validateRevisionPin({
        upstreamRevision: BOUND_RECORD.pinnedApplication.pin.upstreamRevision,
        integrationRevision: BOUND_RECORD.pinnedApplication.pin.integrationRevision,
      }),
    ).toEqual([]);
    expect(validateRevisionPin({}).length).toBe(2);
    expect(
      validateRevisionPin({ upstreamRevision: "   ", integrationRevision: "x" }).some(
        (issue) => issue.field === "pin.upstreamRevision",
      ),
    ).toBe(true);
    expect(
      validateRevisionPin({ upstreamRevision: "x", integrationRevision: "" }).some(
        (issue) => issue.field === "pin.integrationRevision",
      ),
    ).toBe(true);
  });

  test("pin equality is EXACT string equality on both revisions", () => {
    const pin = BOUND_RECORD.pinnedApplication.pin;
    expect(revisionPinsEqual(pin, pin)).toBe(true);
    expect(
      revisionPinsEqual(pin, {
        upstreamRevision: `${pin.upstreamRevision}0`,
        integrationRevision: pin.integrationRevision,
      }),
    ).toBe(false);
    expect(
      revisionPinsEqual(pin, {
        upstreamRevision: pin.upstreamRevision,
        integrationRevision: `${pin.integrationRevision}0`,
      }),
    ).toBe(false);
  });

  test("a demo entry whose pins MISMATCH the bound record is a named revision-mismatch defect, never a rendered demo", () => {
    const resolution = resolveDemoMirrorEntry(
      entryWithPins(
        "000000000000000000000000000000000000dead",
        BOUND_RECORD.pinnedApplication.pin.integrationRevision,
      ),
      BOUND_RECORD,
    );
    expect(resolution.kind).toBe("revision-mismatch");
    if (resolution.kind === "revision-mismatch") {
      expect(resolution.detail).toContain("do not match the bound evidence record's pins");
    }
  });

  test("a demo entry whose integration revision alone mismatches is still a defect (both pins must match exactly)", () => {
    const resolution = resolveDemoMirrorEntry(
      entryWithPins(
        BOUND_RECORD.pinnedApplication.pin.upstreamRevision,
        "000000000000000000000000000000000000beef",
      ),
      BOUND_RECORD,
    );
    expect(resolution.kind).toBe("revision-mismatch");
  });

  test("a demo entry with EXACTLY matching pins resolves to the available projection (same derived status)", () => {
    const resolution = resolveDemoMirrorEntry(
      entryWithPins(
        BOUND_RECORD.pinnedApplication.pin.upstreamRevision,
        BOUND_RECORD.pinnedApplication.pin.integrationRevision,
      ),
      BOUND_RECORD,
    );
    expect(resolution.kind).toBe("available");
    if (resolution.kind === "available") {
      expect(resolution.projection.pin).toEqual(BOUND_RECORD.pinnedApplication.pin);
      expect(resolution.projection.status).toBe("UNASSESSED");
    }
  });

  test("an evidence record with a malformed pin cannot even be BUILT (fail closed before any assessment)", () => {
    const service = createCompatibilityService();
    const malformed: CompatibilityEvidenceRecord = {
      ...BOUND_RECORD,
      recordId: "malformed-pin-record",
      pinnedApplication: {
        ...BOUND_RECORD.pinnedApplication,
        pin: { upstreamRevision: "", integrationRevision: "" },
      },
    };
    expect(() => service.buildRecord(malformed)).toThrow(CompatibilityFlowError);
    expect(() => service.buildRecord(malformed)).toThrow(/upstream revision is mandatory/);
  });
});
