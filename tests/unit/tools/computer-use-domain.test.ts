/**
 * Computer-use domain unit tests (WORK-027, CUI-001/AC-1/AC-5/AC-6/AC-7).
 *
 * The pure layer: the frozen escalation ladder, the deterministic-first
 * route evaluation (the zero-GUI-dispatch decision table), the
 * capability-declaration validation (unregistered/fabricated contracts
 * never become governable state), the action confinement (mode
 * vocabulary + desktop envelope), the escalation target check (no
 * skipping), the egress confinement, the canonical digests and the
 * public observation serialization (content never crosses).
 */

import { describe, expect, it } from "vitest";
import type { ComputerUseActionType } from "../../../src/modules/tools/public";
import {
  ACTION_OBSERVATION_TYPES,
  ACTION_SIDE_EFFECTS,
  AMBIENT_HOST_INHERITANCE,
  BROWSER_COOKIE_JAR_POLICY,
  COMPUTER_USE_MODES,
  canonicalComputerUseJson,
  computerUseObservationDigest,
  computerUseSessionFingerprint,
  DESKTOP_ACTION_GRANTS,
  evaluateComputerUseRoute,
  isComputerUseActionType,
  isTerminalComputerUseSessionStatus,
  MODE_ACTION_VOCABULARIES,
  nextComputerUseMode,
  priorComputerUseModes,
  serializeObservationEvidence,
  validateComputerUseCapability,
  validateComputerUseSessionRequest,
} from "../../../src/modules/tools/public";
import {
  browserDeclaration,
  desktopDeclaration,
  deterministicDeclaration,
  sha256Hex,
} from "./computer-use-world";

describe("computer-use domain: the frozen escalation ladder", () => {
  it("pins the mode order deterministic -> browser -> desktop", () => {
    expect([...COMPUTER_USE_MODES]).toEqual(["deterministic", "browser", "desktop"]);
  });

  it("escalates one step at a time and terminates at desktop", () => {
    expect(nextComputerUseMode("deterministic")).toBe("browser");
    expect(nextComputerUseMode("browser")).toBe("desktop");
    expect(nextComputerUseMode("desktop")).toBeNull();
  });

  it("prior modes are the already-allowed ones", () => {
    expect(priorComputerUseModes("deterministic")).toEqual([]);
    expect(priorComputerUseModes("browser")).toEqual(["deterministic"]);
    expect(priorComputerUseModes("desktop")).toEqual(["deterministic", "browser"]);
  });
});

describe("computer-use domain: the deterministic-first route evaluation", () => {
  it("AC-6: a verified covering deterministic candidate yields a deterministic-ONLY route (zero GUI stages)", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: ["atom-a", "atom-b"],
      qualityTarget: 0.9,
      deterministic: [deterministicDeclaration()],
      browser: browserDeclaration(),
      desktop: desktopDeclaration(),
    });
    expect(evidence.decision).toBe("sufficient");
    expect(evidence.deterministicFirst).toBe("sufficient");
    expect(evidence.route).toHaveLength(1);
    expect(evidence.route[0]?.mode).toBe("deterministic");
    expect(evidence.reasons[0]?.code).toBe("deterministic-coverage-verified");
    // The planner-facing evidence preserves the candidate inventory.
    expect(evidence.deterministicCandidates[0]?.coversRequirements).toBe(true);
    expect(evidence.guiCandidates).toHaveLength(2);
  });

  it("a quality gap escalates to the browser stage (never a blind jump to desktop)", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: ["atom-a", "atom-b"],
      qualityTarget: 0.99,
      deterministic: [deterministicDeclaration()],
      browser: browserDeclaration(),
      desktop: desktopDeclaration(),
    });
    expect(evidence.decision).toBe("insufficient");
    expect(evidence.reasons[0]?.code).toBe("quality-gap");
    expect(evidence.route.map((stage) => stage.mode)).toEqual(["browser", "desktop"]);
  });

  it("an estimated (unverified) quality meeting the target is UNCERTAIN: deterministic stays first as the bounded compare", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: ["atom-a", "atom-b"],
      qualityTarget: 0.9,
      deterministic: [deterministicDeclaration({ qualityConfidence: "estimated" })],
      browser: browserDeclaration(),
      desktop: desktopDeclaration(),
    });
    expect(evidence.decision).toBe("uncertain");
    expect(evidence.reasons[0]?.code).toBe("quality-unverified");
    expect(evidence.route.map((stage) => stage.mode)).toEqual([
      "deterministic",
      "browser",
      "desktop",
    ]);
  });

  it("uncovered requirement atoms are insufficient with the recorded reason", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: ["atom-a", "atom-c"],
      qualityTarget: 0.9,
      deterministic: [deterministicDeclaration()],
      browser: browserDeclaration(),
      desktop: desktopDeclaration(),
    });
    expect(evidence.decision).toBe("insufficient");
    expect(evidence.reasons[0]?.code).toBe("requirement-coverage-unmet");
  });

  it("a desktop-workflow task kind cannot be satisfied deterministically (gui-task-required)", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "desktop-workflow",
      requirementAtoms: ["atom-a", "atom-b"],
      qualityTarget: 0.9,
      deterministic: [deterministicDeclaration()],
      browser: browserDeclaration(),
      desktop: desktopDeclaration(),
    });
    expect(evidence.decision).toBe("insufficient");
    expect(evidence.reasons[0]?.code).toBe("gui-task-required");
  });

  it("no deterministic candidate and no GUI capability records no-route-available (fail-closed input)", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: ["atom-a"],
      qualityTarget: 0.9,
      deterministic: [],
      browser: null,
      desktop: null,
    });
    expect(evidence.decision).toBe("insufficient");
    expect(evidence.route).toHaveLength(0);
    expect(evidence.reasons.map((reason) => reason.code)).toContain("no-deterministic-candidate");
    expect(evidence.reasons.map((reason) => reason.code)).toContain("no-route-available");
  });

  it("empty requirement atoms are never covered (a task must declare what it needs)", () => {
    const evidence = evaluateComputerUseRoute({
      taskKind: "structured-data-retrieval",
      requirementAtoms: [],
      qualityTarget: 0.9,
      deterministic: [deterministicDeclaration()],
      browser: null,
      desktop: null,
    });
    expect(evidence.decision).toBe("insufficient");
  });
});

describe("computer-use domain: capability-declaration validation (AC-5's first half)", () => {
  it("accepts the canonical declarations", () => {
    expect(validateComputerUseCapability(deterministicDeclaration()).valid).toBe(true);
    expect(validateComputerUseCapability(browserDeclaration()).valid).toBe(true);
    expect(validateComputerUseCapability(desktopDeclaration()).valid).toBe(true);
  });

  it("rejects non-objects, bad ids, unknown kinds and bad descriptions", () => {
    expect(validateComputerUseCapability(null).valid).toBe(false);
    expect(validateComputerUseCapability("nope").valid).toBe(false);
    expect(
      validateComputerUseCapability(deterministicDeclaration({ capabilityId: "wrong" })).valid,
    ).toBe(false);
    expect(
      validateComputerUseCapability(deterministicDeclaration({ kind: "phone" as never })).valid,
    ).toBe(false);
    expect(validateComputerUseCapability(deterministicDeclaration({ description: "" })).valid).toBe(
      false,
    );
  });

  it("deterministic capabilities must declare quality + confidence + coverage", () => {
    expect(
      validateComputerUseCapability(deterministicDeclaration({ deterministicQuality: 1.5 })).valid,
    ).toBe(false);
    expect(
      validateComputerUseCapability(
        deterministicDeclaration({ qualityConfidence: "hunch" as never }),
      ).valid,
    ).toBe(false);
    expect(validateComputerUseCapability(deterministicDeclaration({ covers: [] })).valid).toBe(
      false,
    );
  });

  it("GUI capabilities must NOT declare deterministic quality", () => {
    const gui = browserDeclaration({ deterministicQuality: 0.9 as unknown as null });
    expect(validateComputerUseCapability(gui).valid).toBe(false);
  });

  it("browser capabilities declare a non-empty egress allowlist and the fixed isolation profile", () => {
    const noEgress = browserDeclaration({
      browserProfile: {
        egressAllowlist: [],
        cookieJar: BROWSER_COOKIE_JAR_POLICY,
        ambientHostInheritance: AMBIENT_HOST_INHERITANCE,
      },
    });
    expect(validateComputerUseCapability(noEgress).valid).toBe(false);
    const ambient = browserDeclaration({
      browserProfile: {
        egressAllowlist: ["site.example.com"],
        cookieJar: "inherit-host" as never,
        ambientHostInheritance: "none",
      },
    });
    expect(validateComputerUseCapability(ambient).valid).toBe(false);
  });

  it("desktop capabilities declare the full explicit envelope + terminal policy (ambient authority is unrepresentable)", () => {
    expect(validateComputerUseCapability(desktopDeclaration({ desktopEnvelope: null })).valid).toBe(
      false,
    );
    expect(validateComputerUseCapability(desktopDeclaration({ terminalPolicy: null })).valid).toBe(
      false,
    );
    const partial = desktopDeclaration({
      desktopEnvelope: {
        inputDevices: true,
        windowsApps: true,
        filesystem: true,
        network: true,
        clipboard: true,
        downloads: true,
        // terminal missing entirely
      } as never,
    });
    expect(validateComputerUseCapability(partial).valid).toBe(false);
    const networked = desktopDeclaration({
      terminalPolicy: { process: true, filesystem: true, network: true, egressAllowlist: [] },
    });
    expect(validateComputerUseCapability(networked).valid).toBe(false);
  });
});

describe("computer-use domain: confinement checks", () => {
  it("mode action vocabularies confine every action to its mode", () => {
    expect(MODE_ACTION_VOCABULARIES.deterministic).toEqual(["api-call"]);
    for (const action of MODE_ACTION_VOCABULARIES.browser) {
      expect(MODE_ACTION_VOCABULARIES.desktop).not.toContain(action);
    }
    expect(isComputerUseActionType("terminal-exec")).toBe(true);
    expect(isComputerUseActionType("rm -rf")).toBe(false);
  });

  it("every action type carries its frozen side-effect classification and observation types", () => {
    const actionTypes = Object.keys(ACTION_SIDE_EFFECTS) as ComputerUseActionType[];
    for (const actionType of actionTypes) {
      expect(["none", "read-only", "write-external"]).toContain(ACTION_SIDE_EFFECTS[actionType]);
      expect(Array.isArray(ACTION_OBSERVATION_TYPES[actionType])).toBe(true);
      expect(DESKTOP_ACTION_GRANTS[actionType]).toBeDefined();
    }
    expect(ACTION_SIDE_EFFECTS.click).toBe("write-external");
    expect(ACTION_SIDE_EFFECTS["read-dom"]).toBe("read-only");
    expect(ACTION_OBSERVATION_TYPES.screenshot).toEqual(["screenshot"]);
  });

  it("the terminal-status vocabulary marks every status except active terminal", () => {
    expect(isTerminalComputerUseSessionStatus("denied")).toBe(true);
    expect(isTerminalComputerUseSessionStatus("completed")).toBe(true);
    expect(isTerminalComputerUseSessionStatus("active")).toBe(false);
  });
});

describe("computer-use domain: canonical digests + fingerprints", () => {
  it("canonical JSON sorts object keys recursively (the jsonb key-order lesson)", () => {
    expect(canonicalComputerUseJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalComputerUseJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("the observation digest is over the canonical form (key order does not matter)", () => {
    expect(computerUseObservationDigest({ b: 1, a: 2 }, sha256Hex)).toBe(
      computerUseObservationDigest({ a: 2, b: 1 }, sha256Hex),
    );
    expect(computerUseObservationDigest({ a: 2 }, sha256Hex)).not.toBe(
      computerUseObservationDigest({ a: 3 }, sha256Hex),
    );
  });

  it("the session fingerprint discriminates requests deterministically", () => {
    const base = {
      applicationId: "app-1",
      executionId: "exec-1",
      actor: { actorId: "actor-1", tenantId: "tenant-1" },
      task: { kind: "web-workflow" as const, requirementAtoms: ["a"], qualityTarget: 0.9 },
      candidates: { deterministic: ["c1"], browser: null, desktop: null },
      connectionRef: null,
    };
    expect(computerUseSessionFingerprint(base)).toBe(computerUseSessionFingerprint(base));
    expect(computerUseSessionFingerprint(base)).not.toBe(
      computerUseSessionFingerprint({
        ...base,
        task: { ...base.task, qualityTarget: 0.8 },
      }),
    );
  });
});

describe("computer-use domain: session-request validation", () => {
  const validRequest = {
    applicationId: "app-1",
    executionId: "exec-1",
    actor: { actorId: "actor-1", tenantId: "tenant-1" },
    task: { kind: "web-workflow", requirementAtoms: ["a"], qualityTarget: 0.9 },
    candidates: { deterministic: ["c1"], browser: null, desktop: null },
    connectionRef: null,
  };

  it("accepts the canonical request", () => {
    expect(validateComputerUseSessionRequest(validRequest).valid).toBe(true);
  });

  it("requires identity, actor scope, task descriptor and candidates", () => {
    expect(validateComputerUseSessionRequest({ ...validRequest, applicationId: "" }).valid).toBe(
      false,
    );
    expect(validateComputerUseSessionRequest({ ...validRequest, executionId: "" }).valid).toBe(
      false,
    );
    expect(
      validateComputerUseSessionRequest({ ...validRequest, actor: { actorId: "", tenantId: "t" } })
        .valid,
    ).toBe(false);
    expect(
      validateComputerUseSessionRequest({
        ...validRequest,
        task: { ...validRequest.task, kind: "nap" },
      }).valid,
    ).toBe(false);
    expect(
      validateComputerUseSessionRequest({
        ...validRequest,
        task: { ...validRequest.task, qualityTarget: 1.5 },
      }).valid,
    ).toBe(false);
    expect(
      validateComputerUseSessionRequest({
        ...validRequest,
        candidates: { deterministic: "c1" as unknown as string[] },
      }).valid,
    ).toBe(false);
  });
});

describe("computer-use domain: public observation serialization never carries content", () => {
  it("serializes metadata + digests only", () => {
    const evidence = serializeObservationEvidence({
      id: "obs-1",
      applicationId: "app-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      executionId: "exec-1",
      sequence: 3,
      observationType: "dom",
      mode: "browser",
      contentDigest: "d".repeat(64),
      retention: "session",
      redaction: "sensitive-ui",
      content: '<html><input value="hunter2" /></html>',
      artifactRef: null,
      capabilityId: "computer-use-browser-isolated",
      actionId: "action-1",
      observedAt: "2026-09-15T12:00:00Z",
      ledgerSequence: null,
    });
    expect(evidence).not.toHaveProperty("content");
    expect(JSON.stringify(evidence)).not.toContain("hunter2");
    expect(evidence.contentDigest).toBe("d".repeat(64));
    expect(evidence.retention).toBe("session");
    expect(evidence.redaction).toBe("sensitive-ui");
    expect(evidence.observationType).toBe("dom");
  });
});
