/**
 * The capability readiness probe contract (VAL-009, acceptance
 * criteria 2, 3).
 *
 * A probe is a MINIMAL real invocation against a provider's
 * authenticated endpoint (credential via the environment reference
 * only). The contract records the outcome, latency and failure
 * classification — never the credential, never response payloads.
 */

import type { ProviderAccess } from "./matrix";

/** The probe failure taxonomy (criterion 3). */
export const PROBE_FAILURE_KINDS = [
  "auth-rejected",
  "region-blocked",
  "quota-exhausted",
  "network-error",
  "provider-error",
  "not-probed",
] as const;

export type ProbeFailureKind = (typeof PROBE_FAILURE_KINDS)[number];

/** One probe result (recorded evidence — secret-free by contract). */
export interface ProbeResult {
  readonly provider: string;
  readonly credentialEnvVar: string;
  readonly at: string;
  readonly outcome: "ready" | "failed";
  /** Present when the outcome is failed. */
  readonly failure?: ProbeFailureKind;
  readonly latencyMs: number;
  /** Neutral detail: HTTP status / model count — never payloads or keys. */
  readonly detail: string;
  /** Measured cost fact for the probe invocation, when the provider reports one. */
  readonly costMicroUsd?: string;
}

/** One probe rejection finding. */
export interface ProbeViolation {
  readonly path: string;
  readonly reason: string;
}

const NON_EMPTY = /^.+$/;
const MICRO_USD = /^\d+$/;

/**
 * Validate a probe result: provider + env-var NAME present, decided
 * outcome, failure classification when failed, non-negative latency,
 * micro-USD cost when present, and NO secret-shaped material anywhere
 * (the detail must never carry the credential).
 */
export function validateProbeResult(result: ProbeResult): readonly ProbeViolation[] {
  const violations: ProbeViolation[] = [];
  const fail = (path: string, reason: string): void => {
    violations.push({ path, reason });
  };
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || !NON_EMPTY.test(value)) {
      fail(path, "must be a non-empty string");
    }
  };

  requireText("provider", result?.provider);
  requireText("credentialEnvVar", result?.credentialEnvVar);
  requireText("at", result?.at);
  if (result?.outcome !== "ready" && result?.outcome !== "failed") {
    fail("outcome", "must be decided (ready or failed)");
  }
  if (result?.outcome === "failed") {
    const kinds: readonly string[] = PROBE_FAILURE_KINDS;
    if (!kinds.includes(result.failure ?? "")) {
      fail("failure", "a failed probe must classify its failure");
    }
  }
  if (typeof result?.latencyMs !== "number" || result.latencyMs < 0) {
    fail("latencyMs", "must be a non-negative number");
  }
  requireText("detail", result?.detail);
  if (result?.costMicroUsd !== undefined) {
    if (typeof result.costMicroUsd !== "string" || !MICRO_USD.test(result.costMicroUsd)) {
      fail("costMicroUsd", "must be a micro-USD integer string when present");
    }
  }
  const joined = `${result?.provider ?? ""} ${result?.credentialEnvVar ?? ""} ${result?.detail ?? ""}`;
  if (
    /(sk-or-v1-|sk-proj-|sk-ws-|ghp_|gho_|apikey-[A-Za-z0-9]{8}|ak_[A-Za-z0-9]{8}|ck_[A-Za-z0-9]{8}|Bearer\s+[A-Za-z0-9]{16})/.test(
      joined,
    )
  ) {
    fail("detail", "secret-shaped material in a probe record (credentials never enter evidence)");
  }
  return violations;
}

/** The probe plan: what the executor runs for one provider. */
export interface ProbePlan {
  readonly provider: ProviderAccess;
  /** The authenticated endpoint invoked (no credential in the URL). */
  readonly endpoint: string;
  readonly method: "GET" | "POST";
}

/**
 * The probe plans for the authorized provider set — cheap, minimal,
 * authenticated invocations. Generative endpoints with material cost
 * (image/video generation) stay NOT RUN: the probe certifies ACCESS,
 * and the app portfolio executes the real generations.
 */
export function probePlans(): readonly ProbePlan[] {
  return [
    {
      provider: {
        provider: "openrouter",
        credentialEnvVar: "OPENROUTER_API_KEY",
        probeSummary: "authenticated chat completion with a neutral tiny prompt",
      },
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
    },
    {
      provider: {
        provider: "qwen",
        credentialEnvVar: "QWEN_API_KEY",
        probeSummary: "authenticated chat completion with a neutral tiny prompt",
      },
      endpoint: "https://api.qwen.ai/v1/chat/completions",
      method: "POST",
    },
    {
      provider: {
        provider: "openai",
        credentialEnvVar: "OPENAI_API_KEY",
        probeSummary: "authenticated chat completion with a neutral tiny prompt",
      },
      endpoint: "https://api.openai.com/v1/chat/completions",
      method: "POST",
    },
    {
      provider: {
        provider: "byteplus-ark",
        credentialEnvVar: "BYTEPLUS_ARK_API_KEY",
        probeSummary: "authenticated model inventory read (generation itself stays NOT RUN — cost)",
      },
      endpoint: "https://ark.ap-southeast-1.bytepluses.com/api/v3/chat/completions",
      method: "POST",
    },
    {
      provider: {
        provider: "seedance",
        credentialEnvVar: "SEEDANCE_API_KEY",
        probeSummary: "authenticated access probe against the Seedance 2.0 endpoint family",
      },
      endpoint: "https://ark.ap-southeast-1.bytepluses.com/api/v3/chat/completions",
      method: "POST",
    },
  ];
}
