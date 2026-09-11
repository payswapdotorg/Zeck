/**
 * The model/provider capability matrix (VAL-009, acceptance criteria
 * 1, 5).
 *
 * The matrix enumerates every capability the golden corpus declares
 * and maps it to candidate provider access; readiness is resolved ONLY
 * from probe results (criterion 2) — a capability without a successful
 * probe is a GAP, never a silent pass (criterion 4). Provider
 * identifiers are neutral strings; credentials live in the environment
 * and NEVER in the matrix, the code, or any recorded evidence.
 */

import type { GoldenTask } from "../corpus/schema";

/** A capability required by the corpus. */
export interface CapabilityDescriptor {
  readonly capability: string;
  readonly kind: "model" | "agent";
  /** The workload families whose tasks require it. */
  readonly requiredBy: readonly string[];
  /** Candidate provider access (neutral provider names). */
  readonly candidates: readonly string[];
  /**
   * The minimal access requirement surfaced to the operator when the
   * capability resolves to a gap.
   */
  readonly accessRequirement: string;
}

/** A declared provider access seam (credential by env-var NAME only). */
export interface ProviderAccess {
  readonly provider: string;
  readonly credentialEnvVar: string;
  /** What a successful base probe certifies for this provider. */
  readonly probeSummary: string;
}

/** The provider access registry (credential NAMES only — never values). */
export const PROVIDER_ACCESS: readonly ProviderAccess[] = [
  {
    provider: "openrouter",
    credentialEnvVar: "OPENROUTER_API_KEY",
    probeSummary: "authenticated chat completion with a neutral tiny prompt",
  },
  {
    provider: "qwen",
    credentialEnvVar: "QWEN_API_KEY",
    probeSummary: "authenticated chat completion with a neutral tiny prompt",
  },
  {
    provider: "openai",
    credentialEnvVar: "OPENAI_API_KEY",
    probeSummary: "authenticated chat completion with a neutral tiny prompt",
  },
  {
    provider: "byteplus-ark",
    credentialEnvVar: "BYTEPLUS_ARK_API_KEY",
    probeSummary: "authenticated model inventory read (generation itself stays NOT RUN — cost)",
  },
  {
    provider: "seedance",
    credentialEnvVar: "SEEDANCE_API_KEY",
    probeSummary: "authenticated access probe against the Seedance 2.0 endpoint family",
  },
];

/**
 * The capability matrix: every capability the corpus may declare, its
 * candidate providers and its operator-facing access requirement.
 */
export const CAPABILITY_MATRIX: readonly CapabilityDescriptor[] = [
  {
    capability: "model:text",
    kind: "model",
    requiredBy: ["text", "multimodal", "rag", "customer-service", "research", "coding"],
    candidates: ["openrouter", "qwen", "openai"],
    accessRequirement: "any authorized chat-completion-capable provider credential",
  },
  {
    capability: "model:vlm",
    kind: "model",
    requiredBy: ["vlm", "multimodal"],
    candidates: ["openrouter", "openai"],
    accessRequirement: "a vision-language-capable model credential (image + question round trip)",
  },
  {
    capability: "model:vision",
    kind: "model",
    requiredBy: ["image-recognition"],
    candidates: ["openrouter", "openai"],
    accessRequirement: "a vision-capable model credential (image classification/OCR round trip)",
  },
  {
    capability: "model:asr",
    kind: "model",
    requiredBy: ["voice", "multimodal"],
    candidates: ["openai"],
    accessRequirement: "a speech-to-text-capable provider credential (transcription round trip)",
  },
  {
    capability: "model:audio-understanding",
    kind: "model",
    requiredBy: ["audio-understanding"],
    candidates: ["openai"],
    accessRequirement: "an audio-input-capable model credential (audio classification round trip)",
  },
  {
    capability: "model:realtime-voice",
    kind: "model",
    requiredBy: ["realtime-voice"],
    candidates: ["openai"],
    accessRequirement:
      "a realtime-voice session-capable provider credential (streamed turn round trip)",
  },
  {
    capability: "model:image-generation",
    kind: "model",
    requiredBy: ["image-generation"],
    candidates: ["openai", "byteplus-ark"],
    accessRequirement:
      "an image-generation-capable provider credential (one small image generation)",
  },
  {
    capability: "model:video-generation",
    kind: "model",
    requiredBy: ["video-media"],
    candidates: ["byteplus-ark", "seedance"],
    accessRequirement: "a video-generation-capable provider credential (one short clip generation)",
  },
  {
    capability: "model:three-d",
    kind: "model",
    requiredBy: ["three-d"],
    candidates: [],
    accessRequirement:
      "no 3D-generation provider access exists in the authorized set — an explicit provider credential is required",
  },
  {
    capability: "agent:browser",
    kind: "agent",
    requiredBy: ["browser-use"],
    candidates: [],
    accessRequirement:
      "browser-agent execution infrastructure (planned with the app portfolio, VAL-019 — not a model credential)",
  },
  {
    capability: "agent:computer-use",
    kind: "agent",
    requiredBy: ["computer-use"],
    candidates: [],
    accessRequirement:
      "computer-use execution infrastructure (planned with the app portfolio, VAL-019 — not a model credential)",
  },
];

/** One resolved capability. */
export interface CapabilityResolution {
  readonly capability: string;
  readonly status: "ready" | "gap";
  /** Providers with a SUCCESSFUL probe supporting the capability. */
  readonly readyProviders: readonly string[];
  /** Candidate providers without a successful probe. */
  readonly pendingProviders: readonly string[];
  /** The minimal access requirement surfaced to the operator. */
  readonly accessRequirement: string;
}

/**
 * Resolve the matrix against probe outcomes. A capability is READY only
 * when at least one of its candidate providers has a SUCCESSFUL probe;
 * anything else is a GAP carrying the exact access requirement.
 */
export function resolveMatrix(
  probeOutcomes: Readonly<Record<string, "ready" | "failed" | "not-probed">>,
): readonly CapabilityResolution[] {
  return CAPABILITY_MATRIX.map((descriptor) => {
    const readyProviders: string[] = [];
    const pendingProviders: string[] = [];
    for (const candidate of descriptor.candidates) {
      const outcome = probeOutcomes[candidate] ?? "not-probed";
      if (outcome === "ready") {
        readyProviders.push(candidate);
      } else {
        pendingProviders.push(candidate);
      }
    }
    return {
      capability: descriptor.capability,
      status: readyProviders.length > 0 ? "ready" : "gap",
      readyProviders,
      pendingProviders,
      accessRequirement: descriptor.accessRequirement,
    };
  });
}

/**
 * Corpus coverage integrity (criterion 5): every capability any corpus
 * task declares exists in the matrix — an undeclared capability is a
 * validation defect (returned as a violation string).
 */
export function corpusCapabilityCoverage(tasks: readonly GoldenTask[]): readonly string[] {
  const declared = new Set(CAPABILITY_MATRIX.map((d) => d.capability));
  const used = new Set<string>();
  for (const task of tasks) {
    for (const capability of task.requiresCapabilities ?? []) {
      used.add(capability);
      if (!declared.has(capability)) {
        return [`corpus declares unknown capability: ${capability} (${task.taskId})`];
      }
    }
  }
  const unused = [...declared].filter((capability) => !used.has(capability));
  if (unused.length > 0) {
    return [`matrix declares capabilities no corpus task uses: ${unused.join(", ")}`];
  }
  return [];
}
