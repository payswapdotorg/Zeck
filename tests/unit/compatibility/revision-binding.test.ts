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
 *
 * PPR-028A — the fourth binding surface: the Aider PINNED RUNTIME the
 * demo executes must be the exact one the bound record certified
 * (PPR-028 Section B: "that the exact pinned runtime is used, and that
 * an absent/mismatched runtime refuses honestly rather than producing
 * a fixture success"). The entry, the bound record and the registered
 * driver must pin the SAME object; the driver's own version gate must
 * accept only the pinned revision's exact-commit build tag; and an
 * absent runtime must refuse with a named cause — never a guessed run.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AIDER_INTEGRATION_REVISION,
  AIDER_PINNED_BUILD_TAG,
  aiderPinnedRuntimeDriver,
  pinnedAiderVersionMatches,
  verifyPinnedAiderRevision,
} from "../../../compat/aider/runtime/aider-pinned-driver";
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

// ---------------------------------------------------------------------------
// PPR-028A: the Aider binding — the exact pinned runtime (the fourth surface)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The REAL bound record (deploy/evidence/ppr-018.json, work-order wrapper). */
const AIDER_RECORD_WRAPPER = JSON.parse(
  readFileSync(join(REPO_ROOT, "deploy", "evidence", "ppr-018.json"), "utf8"),
) as {
  evidenceRecord: CompatibilityEvidenceRecord;
};
const AIDER_RECORD = AIDER_RECORD_WRAPPER.evidenceRecord;

/** The REAL demo entry (compat/aider/demo/demo-entry.json). */
const AIDER_ENTRY = JSON.parse(
  readFileSync(join(REPO_ROOT, "compat", "aider", "demo", "demo-entry.json"), "utf8"),
) as DemoMirrorEntry;

describe("the Aider binding (PPR-028A): the exact pinned runtime is used, never assumed", () => {
  test("the REAL entry's reproducibility pins EQUAL the REAL bound record's pins (the entry describes the proven revision)", () => {
    expect(AIDER_ENTRY.reproducibility.pinnedUpstreamRevision).toBe(
      AIDER_RECORD.pinnedApplication.pin.upstreamRevision,
    );
    expect(AIDER_ENTRY.reproducibility.integrationRevision).toBe(
      AIDER_RECORD.pinnedApplication.pin.integrationRevision,
    );
    // And the entry resolves against the real record (available — the
    // revision-mismatch resolution is for entries that describe a
    // DIFFERENT revision than the evidence proves).
    const resolution = resolveDemoMirrorEntry(AIDER_ENTRY, AIDER_RECORD);
    expect(resolution.kind).toBe("available");
  });

  test("the registered driver's pins EQUAL the bound record's pins (entry, record and driver pin the SAME object)", () => {
    expect(aiderPinnedRuntimeDriver.pin.upstreamRevision).toBe(
      AIDER_RECORD.pinnedApplication.pin.upstreamRevision,
    );
    expect(aiderPinnedRuntimeDriver.pin.integrationRevision).toBe(
      AIDER_RECORD.pinnedApplication.pin.integrationRevision,
    );
    expect(AIDER_INTEGRATION_REVISION).toBe(AIDER_RECORD.pinnedApplication.pin.integrationRevision);
    // EXACT string equality — the generic rule 2 restated on the real
    // binding's own pins.
    expect(
      revisionPinsEqual(aiderPinnedRuntimeDriver.pin, AIDER_RECORD.pinnedApplication.pin),
    ).toBe(true);
    expect(
      revisionPinsEqual(
        aiderPinnedRuntimeDriver.pin,
        // A one-character drift is a DIFFERENT object — never an update.
        {
          ...AIDER_RECORD.pinnedApplication.pin,
          integrationRevision: `${AIDER_INTEGRATION_REVISION}0`,
        },
      ),
    ).toBe(false);
  });

  test("the version gate accepts ONLY the pinned revision's exact-commit build tag (the installer's dev counter varies; the +g<sha> segment does not)", () => {
    // The certified stamp this binding's venv reports.
    expect(pinnedAiderVersionMatches("aider 0.86.3.dev53+g5dc9490bb")).toBe(true);
    // The PPR-018 worker's environment reported the SAME commit with a
    // different dev counter — the exact-commit tag is what matches.
    expect(pinnedAiderVersionMatches("aider 0.86.3.dev92+g5dc9490bb")).toBe(true);
    // A DIFFERENT commit never matches — even the same version number.
    expect(pinnedAiderVersionMatches("aider 0.86.3.dev53+g1a2b3c4d5")).toBe(false);
    // A released build without the build tag never matches.
    expect(pinnedAiderVersionMatches("aider 0.86.3")).toBe(false);
    expect(pinnedAiderVersionMatches("aider 0.87.0.dev1+g5dc9490bb0000000")).toBe(false);
    // No output at all never matches.
    expect(pinnedAiderVersionMatches("")).toBe(false);
    // The tag itself must be exact — a prefix is not the commit.
    expect(pinnedAiderVersionMatches("aider 0.86.3.dev53+g5dc9490")).toBe(false);
  });

  test("an ABSENT pinned runtime refuses honestly with a named cause (never a fixture success)", async () => {
    const absentVenv = mkdtempSync(join(tmpdir(), "ppr-028a-absent-venv-"));
    const check = await verifyPinnedAiderRevision({ venvPath: absentVenv });
    expect(check.ok).toBe(false);
    expect(check.reported).toBe(null);
    expect(check.cause).toContain("absent");
    expect(check.cause).toContain(AIDER_RECORD.pinnedApplication.pin.upstreamRevision);
    // The refusal names the install instruction (the actionable owner
    // path), never a synthetic fallback.
    expect(check.cause).toContain("pip install -e");
  });

  test("the driver refuses a start against a MISMATCHED binding (fail-closed before any composition)", async () => {
    // The start context carries the binding the BOUND RECORD expects;
    // a different pin is a different object — the driver never starts.
    await expect(
      aiderPinnedRuntimeDriver.start({
        expectedApplicationId: AIDER_RECORD.pinnedApplication.identity.applicationId,
        expectedPin: {
          upstreamRevision: AIDER_RECORD.pinnedApplication.pin.upstreamRevision,
          // One character off: a DIFFERENT integration revision.
          integrationRevision: `${AIDER_INTEGRATION_REVISION}0`,
        },
        runCorrelationId: "ppr-028a-revision-binding-test",
        now: () => "2026-10-11T00:00:00Z",
      }),
    ).rejects.toThrow(/refuses to start against a mismatched binding/);
    // The upstream revision alone mismatching is refused identically.
    await expect(
      aiderPinnedRuntimeDriver.start({
        expectedApplicationId: AIDER_RECORD.pinnedApplication.identity.applicationId,
        expectedPin: {
          upstreamRevision: "9".repeat(40),
          integrationRevision: AIDER_INTEGRATION_REVISION,
        },
        runCorrelationId: "ppr-028a-revision-binding-test",
        now: () => "2026-10-11T00:00:00Z",
      }),
    ).rejects.toThrow(/refuses to start against a mismatched binding/);
    // And so is a mismatched application id.
    await expect(
      aiderPinnedRuntimeDriver.start({
        expectedApplicationId: "00000000-0000-7000-8000-00000000dead",
        expectedPin: {
          upstreamRevision: AIDER_RECORD.pinnedApplication.pin.upstreamRevision,
          integrationRevision: AIDER_INTEGRATION_REVISION,
        },
        runCorrelationId: "ppr-028a-revision-binding-test",
        now: () => "2026-10-11T00:00:00Z",
      }),
    ).rejects.toThrow(/refuses to start against a mismatched binding/);
  });

  test("the driver's runtime id IS the entry's bound runtime (the registry resolution names this driver)", () => {
    expect(aiderPinnedRuntimeDriver.runtimeId).toBe("compat/aider");
    expect(AIDER_ENTRY.runBinding).toEqual({ kind: "pinned-runtime", runtime: "compat/aider" });
    // The build tag exported for the gate names the pinned upstream
    // revision's own short sha (the exact-commit marker).
    expect(AIDER_PINNED_BUILD_TAG).toBe("+g5dc9490bb");
    expect(AIDER_RECORD.pinnedApplication.pin.upstreamRevision.startsWith("5dc9490bb")).toBe(true);
  });
});
