/**
 * Machine-readable artifact reconciliation against the wire contract
 * (DEP-020 acceptance criteria 2, 4, 5).
 *
 * Every machine artifact under docs/developer/machine/ is validated
 * against the AUTHORITATIVE source it projects — mechanically, so
 * documentation drift is a test failure:
 *
 *  - openapi.json            ↔ the LIVE route table of the REAL API
 *                              server (composed through the shared
 *                              in-memory test world) + the wire enums
 *                              (statuses, error codes);
 *  - error-codes.json        ↔ ERROR_CODES (wire) and the REAL
 *                              mapErrorToResponse status mapping (one
 *                              fake reply per code, no re-implemented
 *                              table);
 *  - capability-manifest.json↔ SEED_CAPABILITY_FACTS (capabilities
 *                              module), WORKLOAD_FAMILIES (corpus) and
 *                              PROVIDER_ACCESS (validation matrix);
 *  - env-vars.json           ↔ ZECK_ENV_VAR_NAMES (examples/lib/env.ts
 *                              — the loader the examples actually use);
 *  - examples-manifest.json  ↔ the imported EXAMPLE metadata of every
 *                              example file (classification, family,
 *                              env vars — drift fails);
 *  - integration-recipe.json ↔ existence of every referenced artifact.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PROVIDER_ACCESS } from "../../../benchmarks/validation/capabilities/matrix";
import { WORKLOAD_FAMILIES } from "../../../benchmarks/validation/corpus/schema";
// Static imports of EVERY example module — the manifest is reconciled
// against each file's own exported EXAMPLE metadata (importing never
// auto-executes: the entry guard holds under the test runner).
import { EXAMPLE as agentInventory } from "../../../examples/agent-inventory";
import { EXAMPLE as audioUnderstanding } from "../../../examples/audio-understanding";
import { EXAMPLE as browserUseAgent } from "../../../examples/browser-use-agent";
import { EXAMPLE as codingAssistant } from "../../../examples/coding-assistant";
import { EXAMPLE as computerUseAgent } from "../../../examples/computer-use-agent";
import { EXAMPLE as customerServiceTriage } from "../../../examples/customer-service-triage";
import { EXAMPLE as economicActions } from "../../../examples/economic-actions";
import { EXAMPLE as errorHandling } from "../../../examples/error-handling";
import { EXAMPLE as humanReviewGate } from "../../../examples/human-review-gate";
import { EXAMPLE as imageGeneration } from "../../../examples/image-generation";
import { EXAMPLE as imageRecognition } from "../../../examples/image-recognition";
import { ZECK_ENV_VAR_NAMES } from "../../../examples/lib/env";
import { EXAMPLE as longRunningBatch } from "../../../examples/long-running-batch";
import { EXAMPLE as multimodalTransformation } from "../../../examples/multimodal-transformation";
import { EXAMPLE as operationsRunbook } from "../../../examples/operations-runbook";
import { EXAMPLE as quickstart } from "../../../examples/quickstart";
import { EXAMPLE as ragGroundedAnswers } from "../../../examples/rag-grounded-answers";
import { EXAMPLE as realtimeVoiceSession } from "../../../examples/realtime-voice-session";
import { EXAMPLE as researchSynthesis } from "../../../examples/research-synthesis";
import { EXAMPLE as structuredInvoiceExtraction } from "../../../examples/structured-invoice-extraction";
import { EXAMPLE as textSummarization } from "../../../examples/text-summarization";
import { EXAMPLE as threeDGeneration } from "../../../examples/three-d-generation";
import { EXAMPLE as toolAugmentedLookup } from "../../../examples/tool-augmented-lookup";
import { EXAMPLE as videoGeneration } from "../../../examples/video-generation";
import { EXAMPLE as vlmImageQa } from "../../../examples/vlm-image-qa";
import { EXAMPLE as voiceTranscription } from "../../../examples/voice-transcription";
import { EXAMPLE as webhookReceiver } from "../../../examples/webhook-receiver";
import { EXAMPLE as workflowOrchestration } from "../../../examples/workflow-orchestration";
import { mapErrorToResponse } from "../../../src/api/error-mapper";
import { SEED_CAPABILITY_FACTS } from "../../../src/modules/capabilities/public";
import { PlatformError } from "../../../src/shared/errors";
import {
  ECONOMIC_ACTION_STATUSES,
  ERROR_CODES,
  EXECUTION_STATUSES,
  TERMINAL_STATUSES,
  VERIFICATION_STATUSES,
} from "../../../src/shared/wire";
import { seedApiWorld } from "../api/world";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MACHINE = join(REPOSITORY_ROOT, "docs", "developer", "machine");

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MACHINE, name), "utf8")) as Record<string, unknown>;
}

/** Every example's imported metadata, keyed by manifest path. */
const IMPORTED_EXAMPLES: Record<string, typeof quickstart> = {
  "examples/agent-inventory.ts": agentInventory,
  "examples/audio-understanding.ts": audioUnderstanding,
  "examples/browser-use-agent.ts": browserUseAgent,
  "examples/coding-assistant.ts": codingAssistant,
  "examples/computer-use-agent.ts": computerUseAgent,
  "examples/customer-service-triage.ts": customerServiceTriage,
  "examples/economic-actions.ts": economicActions,
  "examples/error-handling.ts": errorHandling,
  "examples/human-review-gate.ts": humanReviewGate,
  "examples/image-generation.ts": imageGeneration,
  "examples/image-recognition.ts": imageRecognition,
  "examples/long-running-batch.ts": longRunningBatch,
  "examples/multimodal-transformation.ts": multimodalTransformation,
  "examples/operations-runbook.ts": operationsRunbook,
  "examples/quickstart.ts": quickstart,
  "examples/rag-grounded-answers.ts": ragGroundedAnswers,
  "examples/realtime-voice-session.ts": realtimeVoiceSession,
  "examples/research-synthesis.ts": researchSynthesis,
  "examples/structured-invoice-extraction.ts": structuredInvoiceExtraction,
  "examples/text-summarization.ts": textSummarization,
  "examples/three-d-generation.ts": threeDGeneration,
  "examples/tool-augmented-lookup.ts": toolAugmentedLookup,
  "examples/video-generation.ts": videoGeneration,
  "examples/vlm-image-qa.ts": vlmImageQa,
  "examples/voice-transcription.ts": voiceTranscription,
  "examples/webhook-receiver.ts": webhookReceiver,
  "examples/workflow-orchestration.ts": workflowOrchestration,
};

describe("openapi.json reconciles with the live API surface", () => {
  const openapi = loadJson("openapi.json") as {
    paths: Record<string, Record<string, unknown>>;
    servers: { url: string }[];
    components: { schemas: Record<string, { enum?: unknown[] }> };
  };

  test("every live route is documented and every documented route is live (REAL server route table)", async () => {
    const world = await seedApiWorld();
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(openapi.paths)) {
      for (const method of Object.keys(methods)) {
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    const live = new Set(
      world.server.routes.map(
        (route) => `${route.method} ${route.url.replace(/:([A-Za-z0-9]+)/g, "{$1}")}`,
      ),
    );
    expect([...documented].sort()).toEqual([...live].sort());
    expect(live.size).toBe(27);
  });

  test("the error-code enum is exactly the wire contract's ERROR_CODES", () => {
    const publicError = openapi.components.schemas.PublicError as unknown as {
      properties?: { code?: { enum?: unknown[] } };
    };
    expect(publicError?.properties?.code?.enum).toEqual([...ERROR_CODES]);
  });

  test("the execution status enum is exactly the wire contract's", () => {
    const status = openapi.components.schemas.ExecutionStatus;
    expect(status?.enum).toEqual([...EXECUTION_STATUSES]);
  });

  test("the terminal statuses documented match the wire contract's", () => {
    const schema = JSON.stringify(openapi);
    for (const terminal of TERMINAL_STATUSES) {
      expect(schema).toContain(`"${terminal}"`);
    }
  });

  test("the verification, economic-action and webhook schemas match the wire contract", () => {
    expect(openapi.components.schemas.VerificationStatus?.enum).toEqual([...VERIFICATION_STATUSES]);
    expect(openapi.components.schemas.EconomicActionStatus?.enum).toEqual([
      ...ECONOMIC_ACTION_STATUSES,
    ]);
    expect(openapi.components.schemas.WebhookEvent).toBeDefined();
  });

  test("the server URL variable documents the developer env contract", () => {
    expect(openapi.servers[0]?.url).toBe("{baseUrl}");
  });
});

describe("error-codes.json reconciles with the wire taxonomy and the real mapper", () => {
  const table = loadJson("error-codes.json") as {
    errorCodes: { code: string; httpStatus: number; retryGuidance: string }[];
  };

  test("covers EXACTLY the canonical ERROR_CODES (no more, no less)", () => {
    expect(table.errorCodes.map((entry) => entry.code).sort()).toEqual([...ERROR_CODES].sort());
  });

  test("the HTTP statuses match the REAL mapErrorToResponse behavior (one fake reply per code)", () => {
    for (const code of ERROR_CODES) {
      let capturedStatus = -1;
      const reply = {
        status(status: number) {
          capturedStatus = status;
          return reply;
        },
        send: (body: unknown) => body,
        log: { error: () => undefined },
      };
      mapErrorToResponse(reply as never, new PlatformError({ code, message: `probe ${code}` }));
      const documented = table.errorCodes.find((entry) => entry.code === code)?.httpStatus;
      expect(documented, `documented status for ${code}`).toBe(capturedStatus);
    }
  });

  test("every entry carries retry guidance", () => {
    for (const entry of table.errorCodes) {
      expect(entry.retryGuidance.length).toBeGreaterThan(0);
    }
  });
});

describe("capability-manifest.json reconciles with the platform vocabularies", () => {
  const manifest = loadJson("capability-manifest.json") as {
    seedCapabilities: { id: string; kind: string; version: string }[];
    workloadFamilies: {
      family: string;
      example: string;
      classification: string;
      capabilityRequirements: string[];
      availability?: string;
    }[];
    providerAccess: { provider: string; credentialEnvVar: string }[];
  };

  test("the seed capability set is exactly the platform's seeded catalog", () => {
    const seeded = SEED_CAPABILITY_FACTS.map((fact) => ({
      id: fact.claim.id,
      kind: fact.claim.kind,
      version: fact.claim.version,
      attributes: fact.claim.attributes ?? {},
    }));
    expect(manifest.seedCapabilities).toEqual(seeded);
  });

  test("the workload families are exactly the corpus's 22 families", () => {
    expect(manifest.workloadFamilies.map((entry) => entry.family).sort()).toEqual(
      [...WORKLOAD_FAMILIES].sort(),
    );
    expect(manifest.workloadFamilies).toHaveLength(22);
  });

  test("every family's example file exists and classification is the closed vocabulary", () => {
    for (const family of manifest.workloadFamilies) {
      expect(
        family.classification === "runnable" || family.classification === "provider-gated",
        `${family.family}: classification must be the closed vocabulary`,
      ).toBe(true);
      expect(family.example.startsWith("examples/")).toBe(true);
      expect(readFileSync(join(REPOSITORY_ROOT, family.example), "utf8").length).toBeGreaterThan(0);
      expect(family.capabilityRequirements.length).toBeGreaterThan(0);
    }
  });

  test("provider access entries carry credential env var NAMES from the validation matrix", () => {
    const matrixNames = new Set(PROVIDER_ACCESS.map((access) => access.credentialEnvVar));
    for (const access of manifest.providerAccess) {
      if (matrixNames.has(access.credentialEnvVar)) {
        continue;
      }
      // Outside the matrix (e.g. ZECK_3D_API_KEY, the recorded minimum
      // access requirement) the name must still be a credential NAME.
      expect(access.credentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]*_KEY$/);
    }
  });

  test("the honest boundaries are disclosed: gated families carry availability notes", () => {
    for (const family of manifest.workloadFamilies) {
      if (family.classification === "provider-gated") {
        expect(
          family.availability?.length ?? 0,
          `${family.family}: a provider-gated family must carry its recorded boundary`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("env-vars.json reconciles with the loader the examples use", () => {
  const contract = loadJson("env-vars.json") as {
    variables: { name: string; required: boolean; credentialShaped: boolean; storage?: string }[];
  };

  test("the developer variables are exactly ZECK_ENV_VAR_NAMES plus the documented extras", () => {
    const names = contract.variables.map((variable) => variable.name);
    for (const name of ZECK_ENV_VAR_NAMES) {
      expect(names).toContain(name);
    }
    for (const extra of ["ZECK_WEBHOOK_SECRET", "ZECK_WEBHOOK_PORT"]) {
      expect(names).toContain(extra);
    }
  });

  test("credential-shaped variables are flagged and environment-only", () => {
    for (const variable of contract.variables) {
      if (variable.credentialShaped) {
        expect(variable.storage).toBe("environment-only");
      }
    }
  });

  test("provider credential NAMES only — no value can appear", () => {
    const raw = readFileSync(join(MACHINE, "env-vars.json"), "utf8");
    expect(raw).not.toMatch(
      /"(?:OPENROUTER|QWEN|OPENAI|BYTEPLUS_ARK|SEEDANCE|ZECK_3D)_API_KEY"\s*:\s*"[^"]+"/,
    );
  });
});

describe("examples-manifest.json reconciles with every example's own metadata", () => {
  const manifest = loadJson("examples-manifest.json") as {
    examples: {
      path: string;
      name: string;
      family: string;
      title: string;
      classification: string;
      gatedBy?: string;
      envVars: string[];
    }[];
  };

  test("every manifest entry's file exists and matches its imported EXAMPLE metadata", () => {
    for (const entry of manifest.examples) {
      const imported = IMPORTED_EXAMPLES[entry.path];
      expect(
        imported,
        `no imported metadata for ${entry.path} — import it in this test`,
      ).toBeDefined();
      expect(readFileSync(join(REPOSITORY_ROOT, entry.path), "utf8").length).toBeGreaterThan(0);
      expect(imported?.name).toBe(entry.name);
      expect(imported?.family).toBe(entry.family);
      expect(imported?.title).toBe(entry.title);
      expect(imported?.classification.kind).toBe(entry.classification);
      if (imported?.classification.kind === "provider-gated") {
        expect(
          (imported.classification as { note?: string }).note?.length ?? 0,
          `${entry.path}: a provider-gated example must carry its recorded boundary`,
        ).toBeGreaterThan(0);
        const gatedBy = (imported.classification as { gatedBy?: string }).gatedBy;
        if (gatedBy !== undefined) {
          expect(entry.gatedBy).toBe(gatedBy);
        }
      }
      expect([...(imported?.envVars ?? [])].sort()).toEqual([...entry.envVars].sort());
    }
  });

  test("every example .ts file has a manifest entry (lib/ helpers are the only exemption)", () => {
    const exampleFiles = readdirSync(join(REPOSITORY_ROOT, "examples"))
      .filter((entry) => entry.endsWith(".ts"))
      .sort();
    const manifestPaths = manifest.examples
      .map((entry) => entry.path.replace("examples/", ""))
      .sort();
    expect(manifestPaths).toEqual(exampleFiles);
    expect(exampleFiles.length).toBe(27);
  });

  test("importing every example never auto-executes it (the entry guard holds)", () => {
    // All 27 modules were imported statically at load time — reaching
    // this assertion already proves none of them auto-ran (they would
    // have thrown on missing environment variables or hit the network).
    expect(Object.keys(IMPORTED_EXAMPLES)).toHaveLength(27);
  });
});

describe("integration-recipe.json is a complete, resolvable recipe", () => {
  const recipe = loadJson("integration-recipe.json") as {
    steps: { step: number; id: string; action: string; artifacts: string[] }[];
    invariants: string[];
  };

  test("steps are sequential and complete", () => {
    expect(recipe.steps.map((step) => step.step)).toEqual(
      recipe.steps.map((_, index) => index + 1),
    );
    expect(recipe.steps.length).toBe(9);
  });

  test("every referenced artifact exists in the repository (files and directories)", () => {
    const problems: string[] = [];
    const allowedRoots = ["docs/", "examples/", "sdk/", "src/", "tests/", "deploy/", "benchmarks/"];
    for (const step of recipe.steps) {
      expect(step.artifacts.length).toBeGreaterThan(0);
      for (const artifact of step.artifacts) {
        if (!allowedRoots.some((root) => artifact.startsWith(root))) {
          problems.push(`unexpected non-repository artifact: ${artifact}`);
        }
        if (!existsSync(join(REPOSITORY_ROOT, artifact))) {
          problems.push(`artifact does not exist: ${artifact}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the invariants include the binding rules", () => {
    const joined = recipe.invariants.join(" | ");
    expect(joined).toContain("Idempotency-Key");
    expect(joined).toContain("micro-USD");
    expect(joined).toContain("provider");
  });
});
