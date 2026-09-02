import { describe, expect, test } from "vitest";
import {
  canonicalEdgeJson,
  EDGE_KEY_PATTERN,
  edgeApprovalAuthorizes,
  edgeCommandFreshness,
  edgeEnvelopeCoversCommand,
  edgeFingerprintOf,
  isEdgeActuatorChannel,
  isEdgeApprovalStatus,
  isEdgeCommandKind,
  isEdgeDeviceStatus,
  isEdgeDisconnectedPolicy,
  isEdgeEnvelopeStatus,
  isEdgeHealthStatus,
  isEdgeSensorObservationType,
  isEdgeSensorRetention,
  isEdgeWorkloadClass,
  validateEdgeApprovalDecision,
  validateEdgeApprovalRequest,
  validateEdgeCommandRequest,
  validateEdgeDeviceRegistration,
  validateEdgeEnvelopeRequest,
  validateEdgeHealthReport,
  validateEdgeSensorObservation,
} from "../../../src/integrations/edge/public";

const actor = { actorId: "actor-1", tenantId: "tenant-1" };
const base = { applicationId: "app-1", actor } as const;

const envelopeContent = {
  channels: ["locomotion" as const],
  magnitudeBounds: { locomotion: [-100, 100] as [number, number] },
  rateBoundsPerMinute: { locomotion: 60 },
  notBefore: "2026-09-15T12:00:00Z",
  notAfter: "2026-09-15T13:00:00Z",
  maxCommands: 5,
  disconnectedPolicy: "continue-within-envelope" as const,
};

describe("edge domain: canonical JSON + fingerprints", () => {
  test("canonical JSON is key-sorted and digest-stable across key order", () => {
    expect(canonicalEdgeJson({ b: 1, a: 2 })).toBe(canonicalEdgeJson({ a: 2, b: 1 }));
    expect(canonicalEdgeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalEdgeJson({ u: undefined, n: null })).toBe('{"n":null}');
    expect(canonicalEdgeJson([3, { z: 1, y: 2 }])).toBe('[3,{"y":2,"z":1}]');
  });

  test("the fingerprint helper rides the canonical form (digest stability)", () => {
    expect(edgeFingerprintOf({ b: 1, a: { d: 2, c: 3 } })).toBe(
      edgeFingerprintOf({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  test("the idempotency key pattern accepts printable non-empty bounded keys", () => {
    expect(EDGE_KEY_PATTERN.test("k-1")).toBe(true);
    expect(EDGE_KEY_PATTERN.test("")).toBe(false);
    expect(EDGE_KEY_PATTERN.test("key with space")).toBe(false);
    expect(EDGE_KEY_PATTERN.test("k".repeat(201))).toBe(false);
  });
});

describe("edge domain: vocabularies", () => {
  test("the closed vocabularies accept only their members", () => {
    expect(isEdgeDeviceStatus("registered")).toBe(true);
    expect(isEdgeDeviceStatus("paused")).toBe(false);
    expect(isEdgeEnvelopeStatus("admitted")).toBe(true);
    expect(isEdgeCommandKind("actuate")).toBe(true);
    expect(isEdgeCommandKind("spin")).toBe(false);
    expect(isEdgeApprovalStatus("pending")).toBe(true);
    expect(isEdgeHealthStatus("healthy")).toBe(true);
    expect(isEdgeWorkloadClass("embodied")).toBe(true);
    expect(isEdgeWorkloadClass("cyborg")).toBe(false);
    expect(isEdgeActuatorChannel("locomotion")).toBe(true);
    expect(isEdgeActuatorChannel("left-arm")).toBe(false);
    expect(isEdgeDisconnectedPolicy("hold")).toBe(true);
    expect(isEdgeSensorObservationType("telemetry")).toBe(true);
    expect(isEdgeSensorRetention("ephemeral")).toBe(true);
    expect(isEdgeSensorRetention("raw")).toBe(false);
  });
});

describe("edge domain: request validation (fail-closed, total)", () => {
  test("device registration validates the governed shape", () => {
    const valid = {
      ...base,
      label: "cell-1",
      workloadClasses: ["edge", "realtime"],
      capabilityAtoms: ["edge-channel-locomotion"],
      controllerRef: "controller-alpha",
    };
    expect(validateEdgeDeviceRegistration(valid)).toEqual({ valid: true });
    expect(validateEdgeDeviceRegistration({ ...valid, workloadClasses: [] })).toMatchObject({
      valid: false,
    });
    expect(
      validateEdgeDeviceRegistration({ ...valid, workloadClasses: ["edge", "edge"] }),
    ).toMatchObject({ valid: false });
    expect(validateEdgeDeviceRegistration({ ...valid, controllerRef: "" })).toMatchObject({
      valid: false,
    });
    expect(validateEdgeDeviceRegistration(null)).toMatchObject({ valid: false });
  });

  test("envelope admission validates the safety-critical bounds", () => {
    const valid = {
      ...base,
      executionId: "ex-1",
      deviceId: "dev-1",
      approvalId: "appr-1",
      costCeilingMicroUsd: "0",
      content: envelopeContent,
    };
    expect(validateEdgeEnvelopeRequest(valid)).toEqual({ valid: true });
    expect(
      validateEdgeEnvelopeRequest({
        ...valid,
        content: { ...envelopeContent, channels: [] },
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateEdgeEnvelopeRequest({
        ...valid,
        content: { ...envelopeContent, magnitudeBounds: { locomotion: [10, -10] } },
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateEdgeEnvelopeRequest({
        ...valid,
        content: { ...envelopeContent, magnitudeBounds: { locomotion: [-2000, 10] } },
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateEdgeEnvelopeRequest({
        ...valid,
        content: {
          ...envelopeContent,
          notBefore: "2026-09-15T13:00:00Z",
          notAfter: "2026-09-15T12:00:00Z",
        },
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateEdgeEnvelopeRequest({
        ...valid,
        content: { ...envelopeContent, maxCommands: 0 },
      }),
    ).toMatchObject({ valid: false });
    expect(validateEdgeEnvelopeRequest({ ...valid, costCeilingMicroUsd: "-1" })).toMatchObject({
      valid: false,
    });
    expect(validateEdgeEnvelopeRequest({ ...valid, approvalId: "" })).toMatchObject({
      valid: false,
    });
  });

  test("command requests validate the staleness window + magnitude scale", () => {
    const valid = {
      ...base,
      executionId: "ex-1",
      deviceId: "dev-1",
      envelopeId: "env-1",
      commandKind: "actuate",
      channel: "locomotion",
      magnitude: 10,
      payload: { profile: "x" },
      notBefore: "2026-09-15T12:00:00Z",
      notAfter: "2026-09-15T12:05:00Z",
      estimatedMicroUsd: "0",
      approvalId: null,
    };
    expect(validateEdgeCommandRequest(valid)).toEqual({ valid: true });
    expect(validateEdgeCommandRequest({ ...valid, magnitude: 1001 })).toMatchObject({
      valid: false,
    });
    expect(validateEdgeCommandRequest({ ...valid, magnitude: 1.5 })).toMatchObject({
      valid: false,
    });
    expect(
      validateEdgeCommandRequest({ ...valid, notAfter: "2026-09-15T11:59:00Z" }),
    ).toMatchObject({ valid: false });
    expect(validateEdgeCommandRequest({ ...valid, payload: [] })).toMatchObject({ valid: false });
    expect(validateEdgeCommandRequest({ ...valid, estimatedMicroUsd: "1.5" })).toMatchObject({
      valid: false,
    });
  });

  test("approval requests/decisions validate the binding chain + attributability", () => {
    const request = {
      ...base,
      executionId: "ex-1",
      deviceId: "dev-1",
      subjectKind: "command",
      subjectFingerprint: "fp-1",
      policyBasis: "basis-1",
      expiresAt: null,
    };
    expect(validateEdgeApprovalRequest(request)).toEqual({ valid: true });
    expect(validateEdgeApprovalRequest({ ...request, subjectKind: "device" })).toMatchObject({
      valid: false,
    });
    const decision = {
      ...base,
      approvalId: "appr-1",
      approverId: "human-1",
      decision: "approved",
      rationale: "within bounds",
    };
    expect(validateEdgeApprovalDecision(decision)).toEqual({ valid: true });
    expect(validateEdgeApprovalDecision({ ...decision, approverId: "" })).toMatchObject({
      valid: false,
    });
    expect(validateEdgeApprovalDecision({ ...decision, rationale: "" })).toMatchObject({
      valid: false,
    });
  });

  test("sensor observations enforce the retention discipline (ephemeral carries NO content)", () => {
    const valid = {
      ...base,
      executionId: "ex-1",
      deviceId: "dev-1",
      observationType: "telemetry",
      retention: "retained",
      content: "payload",
      observedAt: "2026-09-15T12:00:00Z",
    };
    expect(validateEdgeSensorObservation(valid)).toEqual({ valid: true });
    expect(validateEdgeSensorObservation({ ...valid, retention: "ephemeral" })).toMatchObject({
      valid: false,
    });
    expect(
      validateEdgeSensorObservation({ ...valid, retention: "ephemeral", content: null }),
    ).toEqual({ valid: true }); // ephemeral carries NO content (digest-only)
    expect(validateEdgeSensorObservation({ ...valid, content: null })).toMatchObject({
      valid: false,
    });
  });

  test("health reports validate the neutral metric facts", () => {
    const valid = {
      status: "healthy",
      metrics: { dutyCycle: 0.4 },
      reportedAt: "2026-09-15T12:00:00Z",
    };
    expect(validateEdgeHealthReport(valid)).toEqual({ valid: true });
    expect(validateEdgeHealthReport({ ...valid, status: "flaky" })).toMatchObject({
      valid: false,
    });
    expect(validateEdgeHealthReport({ ...valid, metrics: { secret: "abc" } })).toMatchObject({
      valid: false,
    });
    expect(
      validateEdgeHealthReport({
        ...valid,
        metrics: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`m${i}`, i])),
      }),
    ).toMatchObject({ valid: false });
  });
});

describe("edge domain: the safety core (envelope coverage + staleness)", () => {
  const command = {
    channel: "locomotion" as const,
    magnitude: 50,
    notBefore: "2026-09-15T12:10:00Z",
    notAfter: "2026-09-15T12:20:00Z",
  };
  const now = "2026-09-15T12:15:00Z";

  test("a covered command passes every dimension", () => {
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 0 },
        command,
        now,
      ),
    ).toEqual({ covered: true });
  });

  test("coverage fails closed on every dimension", () => {
    expect(
      edgeEnvelopeCoversCommand(
        { status: "revoked", content: envelopeContent, commandCount: 0 },
        command,
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "superseded", content: envelopeContent, commandCount: 0 },
        command,
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        {
          status: "admitted",
          content: { ...envelopeContent, channels: ["manipulation"] },
          commandCount: 0,
        },
        command,
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        {
          status: "admitted",
          content: { ...envelopeContent, magnitudeBounds: { locomotion: [-10, 10] } },
          commandCount: 0,
        },
        command,
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 5 },
        command,
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 0 },
        command,
        "2026-09-15T11:00:00Z",
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 0 },
        command,
        "2026-09-15T13:30:00Z",
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 0 },
        { ...command, notBefore: "2026-09-15T11:59:00Z" },
        now,
      ),
    ).toMatchObject({ covered: false });
    expect(
      edgeEnvelopeCoversCommand(
        { status: "admitted", content: envelopeContent, commandCount: 0 },
        { ...command, notAfter: "2026-09-15T13:30:00Z" },
        now,
      ),
    ).toMatchObject({ covered: false });
  });

  test("the staleness window is fail-closed (fresh | too-early | stale)", () => {
    const window = { notBefore: "2026-09-15T12:10:00Z", notAfter: "2026-09-15T12:20:00Z" };
    expect(edgeCommandFreshness(window, "2026-09-15T12:15:00Z")).toBe("fresh");
    expect(edgeCommandFreshness(window, "2026-09-15T12:05:00Z")).toBe("too-early");
    expect(edgeCommandFreshness(window, "2026-09-15T12:20:00Z")).toBe("stale");
    expect(edgeCommandFreshness(window, "2026-09-15T12:19:59Z")).toBe("fresh");
  });
});

describe("edge domain: the human-approval authorization check", () => {
  test("an approval authorizes only while approved and unexpired", () => {
    expect(
      edgeApprovalAuthorizes({ status: "approved", expiresAt: null }, "2027-01-01T00:00:00Z"),
    ).toBe(true);
    expect(
      edgeApprovalAuthorizes(
        { status: "approved", expiresAt: "2026-09-15T12:00:00Z" },
        "2026-09-15T12:00:00Z",
      ),
    ).toBe(false);
    expect(
      edgeApprovalAuthorizes(
        { status: "approved", expiresAt: "2026-09-15T13:00:00Z" },
        "2026-09-15T12:00:00Z",
      ),
    ).toBe(true);
    expect(
      edgeApprovalAuthorizes({ status: "pending", expiresAt: null }, "2027-01-01T00:00:00Z"),
    ).toBe(false);
    expect(
      edgeApprovalAuthorizes({ status: "denied", expiresAt: null }, "2027-01-01T00:00:00Z"),
    ).toBe(false);
    expect(
      edgeApprovalAuthorizes({ status: "expired", expiresAt: null }, "2027-01-01T00:00:00Z"),
    ).toBe(false);
  });
});
