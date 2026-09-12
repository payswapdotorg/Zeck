/**
 * VAL-018 platform unit tests: the three-d derivations (pure), the 3D
 * container inspection + verification, the surfaced access
 * requirement, the dispatch binding's pre-dispatch discriminations
 * and honest rail-absent boundary, and the execution driver.
 *
 * Honesty invariants under test:
 *   * a prompt fixture absent from the materialization is a NOT RUN
 *     boundary (thrown BEFORE any lifecycle mutation); the empty
 *     prompt materializes as the corpus's own edge row and is
 *     rejected BEFORE any paid dispatch;
 *   * the structured-description derivation validates the schema
 *     mechanically (unparseable / missing / mistyped fields are
 *     honest invalids, never degraded descriptions);
 *   * 3D outputs verify by container validity + digest ONLY (GLB/OBJ
 *     structure; never aesthetic judgment);
 *   * NO 3D rail exists: a driven dispatch fails with the honest
 *     three-d-rail-absent category, zero rail calls, and the missing
 *     access requirement is surfaced (never a fabricated artifact);
 *   * invalid geometry and wrong-modality tasks are rejected BEFORE
 *     any network effect.
 */

import { describe, expect, test } from "vitest";
import { threeDPromptFixture } from "../../../benchmarks/validation/apps/shared/three-d-scenes";
import { THREE_D_RENDERING_TASKS } from "../../../benchmarks/validation/apps/three-d-rendering/application";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  buildThreeDRequestBody,
  createThreeDDispatchBinding,
  deriveStructuredDescription,
  deriveStructuredDescriptionVerification,
  deriveThreeDPlan,
  deriveThreeDVerification,
  driveThreeDExecution,
  inspectThreeDContainer,
  materializeThreeDInput,
  serializeStructuredDescription,
  THREE_D_ACCESS_REQUIREMENT,
  ThreeDFixtureNotMaterializedError,
  type ThreeDRail,
  type ThreeDRailOutcome,
  type ThreeGeometryParameters,
  threeDContainerIsWellFormed,
  validateThreeGeometry,
} from "../../../benchmarks/validation/platform/three-d";

// ---------------------------------------------------------------------------
// Synthetic 3D artifacts (deterministic, in-test)
// ---------------------------------------------------------------------------

/** A minimal well-formed GLB (header + one JSON chunk). */
function syntheticGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}', "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic "glTF"
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(12 + 8 + json.length, 8); // declared total length
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(json.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // chunk type "JSON"
  return Buffer.concat([header, chunkHeader, json]);
}

/** A minimal well-formed OBJ (vertices + faces). */
function syntheticObj(): Buffer {
  return Buffer.from("# synthetic mesh\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "utf8");
}

function recordingLifecycle(): {
  readonly lifecycle: PlatformLifecyclePort;
  readonly transitions: string[];
} {
  const transitions: string[] = [];
  const lifecycle: PlatformLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision() {
      transitions.push("planning-decision");
    },
    async complete({ verdict }) {
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions };
}

/** A fake rail recording every dispatch (never a network call). */
function fakeRail(
  handler: (input: {
    readonly model: string;
    readonly prompt: string;
    readonly geometry: ThreeGeometryParameters;
  }) => Promise<ThreeDRailOutcome>,
): { readonly rail: ThreeDRail; readonly calls: { model: string; prompt: string }[] } {
  const calls: { model: string; prompt: string }[] = [];
  const rail: ThreeDRail = {
    railId: "fake-three-d",
    async dispatch(input) {
      calls.push({ model: input.model, prompt: input.prompt });
      return await handler(input);
    },
  };
  return { rail, calls };
}

const HEALTHY_TASK = {
  kind: "generate-3d" as const,
  prompt: "prompt-3d-001",
  geometry: {
    primitive: "box" as const,
    dimensions: [2, 1, 2] as const,
    resolution: 2,
    format: "glb" as const,
  },
};

// ---------------------------------------------------------------------------
// Materialization + plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-018 three-d materialization", () => {
  test("every pinned 3D prompt fixture materializes deterministically (same text, same digest)", () => {
    for (const task of THREE_D_RENDERING_TASKS) {
      const first = materializeThreeDInput(task);
      const second = materializeThreeDInput(task);
      expect(first.prompt).toBe(second.prompt);
      expect(first.promptDigest).toBe(second.promptDigest);
      expect(first.promptDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(first.prompt).toBe(threeDPromptFixture(task.prompt).prompt);
    }
  });

  test("the empty prompt materializes as the corpus's own edge row", () => {
    const materialized = materializeThreeDInput({
      kind: "generate-3d",
      prompt: "",
      geometry: HEALTHY_TASK.geometry,
    });
    expect(materialized.prompt).toBe("");
    expect(materialized.promptKey).toBe("");
    expect(materialized.annotation).toBe("empty prompt");
  });

  test("the declared geometry passes through VERBATIM (validation is the binding's job)", () => {
    const materialized = materializeThreeDInput(HEALTHY_TASK);
    expect(materialized.geometry).toEqual(HEALTHY_TASK.geometry);
  });

  test("an absent prompt fixture key is a NOT RUN boundary (thrown, never empty)", () => {
    expect(() =>
      materializeThreeDInput({
        kind: "generate-3d",
        prompt: "prompt-3d-999",
        geometry: HEALTHY_TASK.geometry,
      }),
    ).toThrow(ThreeDFixtureNotMaterializedError);
  });

  test("a task kind outside the 3D vocabulary is a NOT RUN boundary at materialization", () => {
    expect(() =>
      materializeThreeDInput({
        kind: "transform-multimodal",
        source: "img-c-001",
        instruction: "mm-instruction-001",
      } as unknown as Parameters<typeof materializeThreeDInput>[0]),
    ).toThrow(ThreeDFixtureNotMaterializedError);
  });
});

describe("VAL-018 three-d dispatch-plan derivation", () => {
  test("the plan derives the canonical request body and route facts", () => {
    const plan = deriveThreeDPlan(HEALTHY_TASK, { provider: "meshy", model: "Meshy-4" });
    expect(plan.route).toEqual({
      provider: "meshy",
      model: "Meshy-4",
      strategyClass: "single-shot-three-d",
    });
    expect(plan.promptKey).toBe("prompt-3d-001");
    expect(plan.annotation).toBe("single box primitive on ground plane");
    const body = buildThreeDRequestBody({
      model: "Meshy-4",
      prompt: plan.prompt,
      geometry: plan.geometry,
    });
    expect(body).toEqual({
      model: "Meshy-4",
      input: {
        prompt: plan.prompt,
        geometry: {
          primitive: "box",
          dimensions: [2, 1, 2],
          resolution: 2,
        },
        format: "glb",
      },
      parameters: { n: 1 },
    });
  });

  test("request reproducibility: same task -> same request digest; different -> different", () => {
    const first = deriveThreeDPlan(HEALTHY_TASK, { provider: "p", model: "m" });
    const second = deriveThreeDPlan(HEALTHY_TASK, { provider: "p", model: "m" });
    expect(first.requestDigest).toBe(second.requestDigest);
    const other = deriveThreeDPlan(
      { ...HEALTHY_TASK, prompt: "prompt-3d-002" },
      { provider: "p", model: "m" },
    );
    expect(other.requestDigest).not.toBe(first.requestDigest);
    // Different geometry is a different request (digest-level honesty).
    const resized = deriveThreeDPlan(
      {
        ...HEALTHY_TASK,
        geometry: { primitive: "sphere", dimensions: [2, 2, 2], resolution: 2, format: "glb" },
      },
      { provider: "p", model: "m" },
    );
    expect(resized.requestDigest).not.toBe(first.requestDigest);
  });
});

// ---------------------------------------------------------------------------
// Structured-description derivation (the shared cross-modal bridge)
// ---------------------------------------------------------------------------

describe("VAL-018 structured-description derivation", () => {
  const VALID = JSON.stringify({
    subject: "bus",
    colors: ["yellow", "gray"],
    background: "street",
    composition: "bus centered on a road",
  });

  test("a plain JSON answer derives the structured description", () => {
    const result = deriveStructuredDescription(VALID);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.description.subject).toBe("bus");
      expect(result.description.colors).toEqual(["yellow", "gray"]);
    }
  });

  test("markdown-fenced and prose-wrapped answers still derive (the answer is DATA)", () => {
    const fenced = `Here is the description:\n\`\`\`json\n${VALID}\n\`\`\`\nDone.`;
    expect(deriveStructuredDescription(fenced).kind).toBe("valid");
  });

  test("missing / mistyped / empty fields are honest invalids (never degraded)", () => {
    const cases: [string, string][] = [
      ["no JSON at all", "The image shows a bus."],
      ["unparseable JSON", '{"subject": "bus",'],
      ["missing subject", '{"colors":["yellow"],"background":"street","composition":"x"}'],
      ["empty subject", '{"subject":"  ","colors":["y"],"background":"s","composition":"c"}'],
      ["missing colors", '{"subject":"bus","background":"street","composition":"x"}'],
      ["empty colors array", '{"subject":"bus","colors":[],"background":"s","composition":"c"}'],
      [
        "non-string colors entry",
        '{"subject":"bus","colors":[1],"background":"s","composition":"c"}',
      ],
      ["missing background", '{"subject":"bus","colors":["y"],"composition":"c"}'],
      ["missing composition", '{"subject":"bus","colors":["y"],"background":"s"}'],
      ["wrong subject type", '{"subject":42,"colors":["y"],"background":"s","composition":"c"}'],
    ];
    for (const [reason, answer] of cases) {
      const result = deriveStructuredDescription(answer);
      expect(result.kind, reason).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("the serialization is canonical (fixed field order, deterministic)", () => {
    const first = deriveStructuredDescription(VALID);
    const second = deriveStructuredDescription(VALID);
    expect(first.kind).toBe("valid");
    expect(second.kind).toBe("valid");
    if (first.kind === "valid" && second.kind === "valid") {
      expect(serializeStructuredDescription(first.description)).toBe(
        serializeStructuredDescription(second.description),
      );
      const parsed = JSON.parse(serializeStructuredDescription(first.description)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed)).toEqual(["subject", "colors", "background", "composition"]);
    }
  });
});

describe("VAL-018 structured-description verification", () => {
  test("a valid description carrying the oracle terms passes its criteria", () => {
    const result = deriveStructuredDescription(
      JSON.stringify({
        subject: "bus",
        colors: ["yellow"],
        background: "street",
        composition: "bus centered on a road",
      }),
    );
    const criteria = deriveStructuredDescriptionVerification(result, {
      containsText: ["bus"],
    });
    expect(criteria.map((c) => `${c.criterionId}:${c.status}`)).toEqual([
      "structured-description-valid:PASS",
      "contains:bus:PASS",
    ]);
  });

  test("an invalid description FAILS the stage mechanically (single criterion)", () => {
    const criteria = deriveStructuredDescriptionVerification(
      { kind: "invalid", reason: "unparseable JSON" },
      { containsText: ["bus"] },
    );
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.criterionId).toBe("structured-description-valid");
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.evidence[0]).toContain("invalid:unparseable JSON");
  });

  test("a valid description missing the oracle term fails its criterion (ground truth)", () => {
    const result = deriveStructuredDescription(
      JSON.stringify({
        subject: "vehicle",
        colors: ["yellow"],
        background: "street",
        composition: "centered",
      }),
    );
    const criteria = deriveStructuredDescriptionVerification(result, {
      containsText: ["bus"],
    });
    expect(criteria.map((c) => c.status)).toEqual(["PASS", "FAIL"]);
  });

  test("criteria evidence carries the digest, never the answer payload", () => {
    const result = deriveStructuredDescription(
      JSON.stringify({
        subject: "bus",
        colors: ["yellow"],
        background: "street",
        composition: "road scene",
      }),
    );
    const criteria = deriveStructuredDescriptionVerification(result, { containsText: ["bus"] });
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain("digest:");
    expect(evidence).not.toContain("road scene");
  });
});

// ---------------------------------------------------------------------------
// 3D container inspection + verification (container validity + digest)
// ---------------------------------------------------------------------------

describe("VAL-018 3D container inspection and verification", () => {
  test("a well-formed GLB inspects as glb (version + declared length)", () => {
    const glb = syntheticGlb();
    const inspection = inspectThreeDContainer(glb);
    expect(inspection.kind).toBe("glb");
    expect(inspection.version).toBe(2);
    expect(inspection.declaredLength).toBe(glb.length);
    expect(threeDContainerIsWellFormed(inspection, glb).wellFormed).toBe(true);
  });

  test("a well-formed OBJ inspects as obj (vertex + face lines)", () => {
    const obj = syntheticObj();
    const inspection = inspectThreeDContainer(obj);
    expect(inspection.kind).toBe("obj");
    expect(inspection.vertexLines).toBe(3);
    expect(inspection.faceLines).toBe(1);
    expect(threeDContainerIsWellFormed(inspection, obj).wellFormed).toBe(true);
  });

  test("garbage bytes are honestly unknown (never a fabricated container)", () => {
    const garbage = Buffer.alloc(512, 0xa5);
    const inspection = inspectThreeDContainer(garbage);
    expect(inspection.kind).toBe("unknown");
    expect(threeDContainerIsWellFormed(inspection, garbage).wellFormed).toBe(false);
  });

  test("a truncated GLB (declared length disagrees) is mechanically malformed", () => {
    const truncated = syntheticGlb().subarray(0, 18);
    const inspection = inspectThreeDContainer(truncated);
    expect(inspection.kind).toBe("glb");
    expect(threeDContainerIsWellFormed(inspection, truncated).wellFormed).toBe(false);
  });

  test("a synthetic GLB artifact passes the mechanical criteria (container+digest)", () => {
    const criteria = deriveThreeDVerification(HEALTHY_TASK, {
      kind: "success",
      artifact: { bytes: syntheticGlb(), container: "glb" },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("three-d-container")).toBe("PASS");
    expect(byId.get("container-format-declared")).toBe("PASS");
    expect(byId.get("payload-nonempty")).toBe("PASS");
    expect(byId.get("digest-captured")).toBe("PASS");
  });

  test("an OBJ artifact against a glb-declaring task fails the format criterion", () => {
    const criteria = deriveThreeDVerification(HEALTHY_TASK, {
      kind: "success",
      artifact: { bytes: syntheticObj(), container: "obj" },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("three-d-container")).toBe("PASS"); // the payload was real OBJ
    expect(byId.get("container-format-declared")).toBe("FAIL"); // but the task declared glb
  });

  test("a garbage artifact fails the container criterion — never a fabricated completion", () => {
    const criteria = deriveThreeDVerification(HEALTHY_TASK, {
      kind: "success",
      artifact: { bytes: Buffer.alloc(512, 0xa5), container: "unknown" },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("three-d-container")).toBe("FAIL");
  });

  test("a rail failure FAILS the run mechanically (honest category recorded)", () => {
    const criteria = deriveThreeDVerification(HEALTHY_TASK, {
      kind: "failure",
      category: "three-d-rail-absent",
      message: "no 3D provider rail exists",
      retryable: false,
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.evidence[0]).toBe("provider-failure:three-d-rail-absent");
  });

  test("criteria evidence carries the artifact digest, never the artifact bytes", () => {
    const glb = syntheticGlb();
    const criteria = deriveThreeDVerification(HEALTHY_TASK, {
      kind: "success",
      artifact: { bytes: glb, container: "glb" },
    });
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain("digest:");
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain(glb.subarray(12).toString("base64").slice(0, 24));
  });
});

// ---------------------------------------------------------------------------
// The surfaced missing-access requirement
// ---------------------------------------------------------------------------

describe("VAL-018 surfaced 3D access requirement", () => {
  test("the exact missing access requirement is surfaced (per the roadmap policy)", () => {
    expect(THREE_D_ACCESS_REQUIREMENT.capability).toBe("model:three-d");
    expect(THREE_D_ACCESS_REQUIREMENT.providerCandidates.length).toBeGreaterThanOrEqual(2);
    for (const candidate of THREE_D_ACCESS_REQUIREMENT.providerCandidates) {
      expect(candidate.provider.length).toBeGreaterThan(0);
      expect(candidate.models.length).toBeGreaterThan(0);
    }
    expect(THREE_D_ACCESS_REQUIREMENT.whyNeeded.length).toBeGreaterThan(20);
    expect(THREE_D_ACCESS_REQUIREMENT.experimentUnlocked.length).toBeGreaterThan(20);
    expect(THREE_D_ACCESS_REQUIREMENT.minimumCredential).toContain("env");
  });

  test("the requirement carries NO secret material (names, never values)", () => {
    const serialized = JSON.stringify(THREE_D_ACCESS_REQUIREMENT);
    expect(serialized).not.toMatch(/sk-[a-z0-9]/i);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/i);
  });
});

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations + honest NOT-RUN)
// ---------------------------------------------------------------------------

describe("VAL-018 three-d dispatch binding", () => {
  test("NO rail exists: a driven dispatch fails honestly with three-d-rail-absent, zero rail calls", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
    }));
    // The binding is constructed WITHOUT the rail (the honest state).
    const binding = createThreeDDispatchBinding({ railCalls: { count: 0 } });
    const outcome = await binding({
      executionId: "e",
      task: HEALTHY_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "three-d-rail-absent",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
    expect(rail.railId).toBe("fake-three-d"); // the fake exists but was never wired in
  });

  test("a wrong-modality task is rejected BEFORE any network effect", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
    }));
    const binding = createThreeDDispatchBinding({ rail, railCalls: { count: 0 } });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "classify-image", image: "img-c-001", labels: ["x"] } as never,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("a tampered materialization (digest mismatch) is rejected BEFORE any rail call", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
    }));
    const binding = createThreeDDispatchBinding({
      rail,
      materialize: (task) => ({
        ...materializeThreeDInput(task),
        prompt: "a tampered prompt",
        promptDigest: "deadbeefdeadbeef",
      }),
      railCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: HEALTHY_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "fixture-digest-mismatch",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("the empty-prompt edge row is rejected before any paid dispatch", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
    }));
    const binding = createThreeDDispatchBinding({ rail, railCalls: { count: 0 } });
    const outcome = await binding({
      executionId: "e",
      task: { ...HEALTHY_TASK, prompt: "" },
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("mechanically invalid geometry is rejected before any rail call (the mesh edge rows)", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
    }));
    const binding = createThreeDDispatchBinding({ rail, railCalls: { count: 0 } });
    const invalidGeometrys: ThreeGeometryParameters[] = [
      { primitive: "box", dimensions: [-1, 1, 1], resolution: 2, format: "glb" },
      { primitive: "box", dimensions: [1, 1, 1], resolution: 0, format: "glb" },
      {
        primitive: "torus" as unknown as ThreeGeometryParameters["primitive"],
        dimensions: [1, 1, 1],
        resolution: 2,
        format: "glb",
      },
      {
        primitive: "box",
        dimensions: [1, 1, 1],
        resolution: 2,
        format: "ply" as unknown as ThreeGeometryParameters["format"],
      },
    ];
    for (const geometry of invalidGeometrys) {
      const outcome = await binding({
        executionId: "e",
        task: { ...HEALTHY_TASK, geometry },
        provider: "p",
        model: "m",
      });
      expect(outcome).toMatchObject({
        kind: "failure",
        category: "invalid-geometry",
        retryable: false,
      });
    }
    expect(validateThreeGeometry(HEALTHY_TASK.geometry).valid).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("with a rail wired in, the dispatch carries the exact seeded prompt + geometry", async () => {
    const { rail, calls } = fakeRail(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGlb(), container: "glb" as const },
      usage: { inputTokens: 12, outputTokens: 1 },
    }));
    const binding = createThreeDDispatchBinding({ rail, railCalls: { count: 0 } });
    const outcome = await binding({
      executionId: "e",
      task: HEALTHY_TASK,
      provider: "meshy",
      model: "Meshy-4",
    });
    expect(outcome.kind).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe(threeDPromptFixture("prompt-3d-001").prompt);
    if (outcome.kind === "success") {
      expect(outcome.usage?.inputTokens).toBe(12);
    }
  });

  test("retry honesty: retryable failures retried exactly per policy; non-retryable never", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const { rail, calls } = fakeRail(async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) {
        return {
          kind: "failure" as const,
          category: "rate-limit",
          message: "429",
          retryable: true,
        };
      }
      return {
        kind: "success" as const,
        artifact: { bytes: syntheticGlb(), container: "glb" as const },
      };
    });
    const binding = createThreeDDispatchBinding({
      rail,
      railCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({
      executionId: "e",
      task: HEALTHY_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome.kind).toBe("success");
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([25]);
    expect(calls).toHaveLength(2);

    // A NON-retryable failure is attempted exactly once.
    const singleAttempts: number[] = [];
    const failing = fakeRail(async () => {
      singleAttempts.push(singleAttempts.length + 1);
      return {
        kind: "failure" as const,
        category: "invalid-request",
        message: "bad geometry",
        retryable: false,
      };
    });
    const failingBinding = createThreeDDispatchBinding({
      rail: failing.rail,
      railCalls: { count: 0 },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedOutcome = await failingBinding({
      executionId: "e2",
      task: HEALTHY_TASK,
      provider: "p",
      model: "m",
    });
    expect(failedOutcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    expect(singleAttempts).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The execution driver (lifecycle order + honest terminals)
// ---------------------------------------------------------------------------

describe("VAL-018 three-d execution driver", () => {
  test("drives the canonical lifecycle with the planning decision before dispatch", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const result = await driveThreeDExecution({
      executionId: "exec-1",
      task: HEALTHY_TASK,
      provider: "meshy",
      model: "Meshy-4",
      ports: {
        lifecycle,
        dispatch: async () => {
          dispatchTransitions.push(...transitions);
          return {
            kind: "success",
            artifact: { bytes: syntheticGlb(), container: "glb" },
            usage: { inputTokens: 12, outputTokens: 1 },
          };
        },
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "queue",
      "start",
      "verify",
      "complete:pass",
    ]);
    expect(dispatchTransitions).toContain("planning-decision");
    expect(dispatchTransitions).not.toContain("verify");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.requestDigest).not.toBeNull();
    expect(result.artifactDigest).not.toBeNull();
    expect(result.artifactContainer).toBe("glb");
    expect(result.dispatchLatencyMs).toBe(0);
  });

  test("with NO rail, the execution completes honestly as FAILED (rail-absent)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const binding = createThreeDDispatchBinding({ railCalls: { count: 0 } });
    const result = await driveThreeDExecution({
      executionId: "exec-2",
      task: HEALTHY_TASK,
      provider: "none",
      model: "none",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    expect(result.usage).toBeNull();
    expect(result.artifactDigest).toBeNull();
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:three-d-rail-absent");
  });

  test("a missing prompt fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveThreeDExecution({
        executionId: "exec-3",
        task: { ...HEALTHY_TASK, prompt: "prompt-3d-999" },
        provider: "p",
        model: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({
            kind: "success",
            artifact: { bytes: syntheticGlb(), container: "glb" },
          }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(ThreeDFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});
