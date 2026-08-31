/**
 * Unit tests — the deployment fabric domain (WORK-023, MOD-001).
 *
 * Proves the intended behavior AND the protected negative cases of
 * the frozen vocabularies and fail-closed validations: profile
 * declarations (modality/channel/capability/latency/resource/
 * side-effect/io vocabularies, duplicates, bounds, secret scans),
 * plan bodies (reference shapes, BYOA descriptors, channel bindings,
 * session policy bounds), the creation input, the strict control-
 * plane transitions and the content-addressing determinism.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
} from "../../../src/modules/deployments/public";
import {
  canonicalPlanJson,
  canonicalProfileJson,
  DEPLOYMENT_CHANNEL_KINDS,
  DEPLOYMENT_EVENT_KINDS,
  DEPLOYMENT_IO_MODALITIES,
  DEPLOYMENT_LATENCY_CLASSES,
  DEPLOYMENT_MODALITIES,
  DEPLOYMENT_RESOURCE_CLASSES,
  DEPLOYMENT_SIDE_EFFECT_CLASSES,
  DEPLOYMENT_STATUS_TRANSITIONS,
  DEPLOYMENT_STATUSES,
  validateCreateDeploymentInput,
  validateDeploymentPlanInput,
  validateDeploymentProfileInput,
} from "../../../src/modules/deployments/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

function profileInput(overrides: Partial<DeploymentProfileInput> = {}): DeploymentProfileInput {
  return {
    profileId: "support-voice",
    modality: "realtime-voice",
    channelKinds: ["web", "telephony"],
    requiredCapabilities: ["realtime-conversation"],
    latencyClass: "realtime",
    resourceClass: "standard",
    sideEffectClass: "read-only",
    inputModalities: ["audio"],
    outputModalities: ["audio", "text"],
    description: "Support voice receptionist",
    ...overrides,
  };
}

function planInput(overrides: Partial<DeploymentPlanInput> = {}): DeploymentPlanInput {
  return {
    planId: "support-voice-plan",
    profileRef: { profileId: "support-voice", version: 1 },
    agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
    environmentId: ENV_ID,
    channelBindings: [
      { channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" },
      { channelKind: "telephony", adapterCapabilityId: "telephony-channel-adapter" },
    ],
    sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
    description: "Initial plan",
    ...overrides,
  };
}

describe("the frozen deployment vocabularies", () => {
  test("modality vocabulary is the ADR-0014 set plus future escapes", () => {
    expect([...DEPLOYMENT_MODALITIES]).toEqual([
      "realtime-voice",
      "messaging",
      "media-generation",
      "document-vision",
      "realtime-multimodal",
      "background-automation",
      "custom",
    ]);
  });

  test("channel kinds, latency, resource, side-effect and io vocabularies are frozen", () => {
    expect([...DEPLOYMENT_CHANNEL_KINDS]).toHaveLength(6);
    expect([...DEPLOYMENT_LATENCY_CLASSES]).toEqual(["realtime", "interactive", "asynchronous"]);
    expect([...DEPLOYMENT_RESOURCE_CLASSES]).toHaveLength(4);
    expect([...DEPLOYMENT_SIDE_EFFECT_CLASSES]).toEqual(["none", "read-only", "write-external"]);
    expect([...DEPLOYMENT_IO_MODALITIES]).toHaveLength(5);
    expect([...DEPLOYMENT_EVENT_KINDS]).toEqual([
      "create",
      "promote",
      "rollback",
      "suspend",
      "resume",
      "retire",
    ]);
    expect([...DEPLOYMENT_STATUSES]).toEqual(["active", "suspended", "retired"]);
  });
});

describe("profile validation (fail-closed)", () => {
  test("a well-formed profile passes", () => {
    expect(validateDeploymentProfileInput(profileInput()).valid).toBe(true);
  });

  test("vocabulary violations are rejected", () => {
    expect(validateDeploymentProfileInput(profileInput({ modality: "voice" as never })).valid).toBe(
      false,
    );
    expect(
      validateDeploymentProfileInput(profileInput({ channelKinds: ["whatsapp" as never] })).valid,
    ).toBe(false);
    expect(
      validateDeploymentProfileInput(profileInput({ latencyClass: "urgent" as never })).valid,
    ).toBe(false);
    expect(
      validateDeploymentProfileInput(profileInput({ resourceClass: "gpu" as never })).valid,
    ).toBe(false);
    expect(
      validateDeploymentProfileInput(profileInput({ sideEffectClass: "mutating" as never })).valid,
    ).toBe(false);
    expect(
      validateDeploymentProfileInput(profileInput({ inputModalities: ["smell" as never] })).valid,
    ).toBe(false);
  });

  test("at least one channel kind; no duplicates", () => {
    expect(validateDeploymentProfileInput(profileInput({ channelKinds: [] })).valid).toBe(false);
    expect(
      validateDeploymentProfileInput(profileInput({ channelKinds: ["web", "web"] })).valid,
    ).toBe(false);
  });

  test("secret-shaped descriptions are rejected", () => {
    const check = validateDeploymentProfileInput(
      profileInput({ description: "key: sk-abcdefghijklmnopqrstuvwx" }),
    );
    expect(check.valid).toBe(false);
  });

  test("bounded free text", () => {
    expect(
      validateDeploymentProfileInput(profileInput({ description: "x".repeat(2001) })).valid,
    ).toBe(false);
  });
});

describe("plan validation (fail-closed)", () => {
  test("a well-formed plan passes", () => {
    expect(validateDeploymentPlanInput(planInput()).valid).toBe(true);
  });

  test("agent reference shape is enforced", () => {
    expect(
      validateDeploymentPlanInput(
        planInput({
          agentRef: { agentId: "not-a-uuid", agentVersion: "1.0.0", agentKind: "zeck" },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({ agentRef: { agentId: AGENT_ID, agentVersion: "1.0", agentKind: "zeck" } }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({
          agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "hybrid" as never },
        }),
      ).valid,
    ).toBe(false);
  });

  test("BYOA requires an opaque descriptor; zeck forbids one", () => {
    expect(
      validateDeploymentPlanInput(
        planInput({ agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "byoa" } }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({
          agentRef: {
            agentId: AGENT_ID,
            agentVersion: "1.0.0",
            agentKind: "byoa",
            externalDescriptor: {
              ref: "external/agent-ref-1",
              descriptor: "Customer-hosted agent",
            },
          },
        }),
      ).valid,
    ).toBe(true);
    expect(
      validateDeploymentPlanInput(
        planInput({
          agentRef: {
            agentId: AGENT_ID,
            agentVersion: "1.0.0",
            agentKind: "zeck",
            externalDescriptor: { ref: "x", descriptor: "y" },
          },
        }),
      ).valid,
    ).toBe(false);
  });

  test("a credential-shaped byoa descriptor is rejected (MOD-010's honesty)", () => {
    const check = validateDeploymentPlanInput(
      planInput({
        agentRef: {
          agentId: AGENT_ID,
          agentVersion: "1.0.0",
          agentKind: "byoa",
          externalDescriptor: { ref: "sk-abcdefghijklmnopqrstuvwx", descriptor: "token" },
        },
      }),
    );
    expect(check.valid).toBe(false);
  });

  test("channel bindings: at least one, no duplicate channel kinds, neutral adapter ids", () => {
    expect(validateDeploymentPlanInput(planInput({ channelBindings: [] })).valid).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({
          channelBindings: [
            { channelKind: "web", adapterCapabilityId: "a-1" },
            { channelKind: "web", adapterCapabilityId: "a-2" },
          ],
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({ channelBindings: [{ channelKind: "web", adapterCapabilityId: "Bad_Id" }] }),
      ).valid,
    ).toBe(false);
  });

  test("session policy bounds are enforced", () => {
    expect(
      validateDeploymentPlanInput(
        planInput({ sessionPolicy: { maxSessionDurationMs: 0, maxConcurrentSessions: 1 } }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({
          sessionPolicy: { maxSessionDurationMs: 86_400_001, maxConcurrentSessions: 1 },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateDeploymentPlanInput(
        planInput({ sessionPolicy: { maxSessionDurationMs: 1000, maxConcurrentSessions: 0 } }),
      ).valid,
    ).toBe(false);
  });
});

describe("the control-plane lifecycle", () => {
  test("strict status transitions (plan moves are guarded separately)", () => {
    expect(DEPLOYMENT_STATUS_TRANSITIONS.active).toEqual(["suspended", "retired"]);
    expect(DEPLOYMENT_STATUS_TRANSITIONS.suspended).toEqual(["active", "retired"]);
    expect(DEPLOYMENT_STATUS_TRANSITIONS.retired).toEqual([]);
  });
});

describe("creation input validation", () => {
  function creationInput(overrides: Partial<CreateDeploymentInput> = {}): CreateDeploymentInput {
    return {
      slug: "support-voice-prod",
      name: "Support voice (production)",
      environmentId: ENV_ID,
      agentId: AGENT_ID,
      agentVersion: "1.0.0",
      agentKind: "zeck",
      planId: "support-voice-plan",
      ...overrides,
    };
  }

  test("a well-formed creation passes", () => {
    expect(validateCreateDeploymentInput(creationInput()).valid).toBe(true);
  });

  test("uuids, versions and kinds are enforced", () => {
    expect(validateCreateDeploymentInput(creationInput({ environmentId: "x" })).valid).toBe(false);
    expect(validateCreateDeploymentInput(creationInput({ agentId: "x" })).valid).toBe(false);
    expect(validateCreateDeploymentInput(creationInput({ agentVersion: "1" })).valid).toBe(false);
    expect(
      validateCreateDeploymentInput(creationInput({ agentKind: "hybrid" as never })).valid,
    ).toBe(false);
    expect(validateCreateDeploymentInput(creationInput({ slug: "UPPER" })).valid).toBe(false);
  });
});

describe("content addressing (deterministic)", () => {
  test("the same profile body digests identically under any key/list order", () => {
    const a = canonicalProfileJson(profileInput());
    const shuffled: DeploymentProfileInput = {
      description: "Support voice receptionist",
      outputModalities: ["text", "audio"],
      inputModalities: ["audio"],
      sideEffectClass: "read-only",
      resourceClass: "standard",
      latencyClass: "realtime",
      requiredCapabilities: ["realtime-conversation"],
      channelKinds: ["telephony", "web"],
      modality: "realtime-voice",
      profileId: "support-voice",
    };
    expect(canonicalProfileJson(shuffled)).toBe(a);
    expect(digest(a)).toBe(digest(a));
  });

  test("any semantic change changes the profile digest", () => {
    const a = canonicalProfileJson(profileInput());
    const b = canonicalProfileJson(profileInput({ latencyClass: "interactive" }));
    expect(digest(a)).not.toBe(digest(b));
  });

  test("the same plan body digests identically; changes differ", () => {
    const a = canonicalPlanJson(planInput());
    const b = canonicalPlanJson(
      planInput({ channelBindings: [...planInput().channelBindings].reverse() }),
    );
    expect(b).toBe(a); // bindings are canonically sorted
    const c = canonicalPlanJson(
      planInput({ environmentId: "00000000-0000-7000-8000-0000000000b2" }),
    );
    expect(digest(a)).not.toBe(digest(c));
  });
});
