/**
 * Customer-runner registration submission (runners integration domain;
 * WORK-019, ENV-003).
 *
 * The EXTERNAL, customer-facing shape of a runner registration: what a
 * customer's environment submits to adopt its runner into the Zeck fleet.
 * The submission is UNTRUSTED input by contract — validated here against
 * the neutral vocabulary (fail-closed: an invalid submission never reaches
 * the sandbox authority), then mapped onto the sandbox module's fleet
 * registration input by the application gateway:
 *
 *   - the runner's declared capabilities use the provider-neutral runner
 *     vocabulary (the sandbox authority owns the vocabulary);
 *   - the endpoint reference is an OPAQUE identifier (host-shaped paths
 *     are rejected — the sandbox environment contract's rule, restated);
 *   - the registration token is a bounded opaque string (never a reused
 *     provider credential: raw secret-shaped values are rejected BEFORE
 *     anything durable; the platform stores only its one-way fingerprint);
 *   - the runner identity claims (slug/name/version) follow the fleet's
 *     identity rules.
 *
 * Provider neutrality: no runner vendor, agent framework, transport SDK
 * or cloud identifier exists anywhere in this file — those live behind
 * the adapters.
 */

import {
  containsRawSecretValue,
  type RunnerProvenance,
  refLooksLikeHostPath,
  validateRunnerCapabilities,
} from "../../../modules/sandbox/public";

/** The external registration submission (untrusted input, by contract). */
export interface ExternalRunnerRegistration {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The customer-runner compute environment this runner serves. */
  readonly environmentId: string;
  readonly slug: string;
  readonly name: string;
  readonly runnerVersion: string;
  /** Descriptive capabilities from the neutral runner vocabulary. */
  readonly declaredCapabilities: readonly string[];
  /**
   * The opaque endpoint reference of the customer runner (never a host
   * path; the owning channel adapter resolves it behind its own config).
   */
  readonly endpointRef: string;
  /** The registration token (stored hashed by the authority, never returned). */
  readonly registrationToken: string;
  /** Who/what submitted the registration (the platform-side actor identity). */
  readonly submittedBy: string;
}

export interface RunnerSubmissionValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

const ENDPOINT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SUBMITTER_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Validate an external runner registration (fail-closed). The submission
 * is untrusted input: every field is validated against the neutral
 * vocabulary, raw secret-shaped tokens are rejected outright and
 * host-shaped endpoint references are refused.
 */
export function validateExternalRunnerRegistration(
  submission: ExternalRunnerRegistration,
): RunnerSubmissionValidation {
  if (typeof submission?.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(submission.slug)) {
    return { valid: false, reason: "runner slug must be lowercase alphanumeric/hyphen (max 64)" };
  }
  if (
    typeof submission?.name !== "string" ||
    submission.name.length < 1 ||
    submission.name.length > 200
  ) {
    return { valid: false, reason: "runner name must be 1..200 characters" };
  }
  if (!/^\d+\.\d+\.\d+$/.test(submission?.runnerVersion ?? "")) {
    return { valid: false, reason: "runner version must be major.minor.patch numerics" };
  }
  const capabilityCheck = validateRunnerCapabilities(submission?.declaredCapabilities ?? []);
  if (!capabilityCheck.valid) {
    return { valid: false, reason: `declared capabilities rejected: ${capabilityCheck.reason}` };
  }
  if (
    typeof submission?.endpointRef !== "string" ||
    !ENDPOINT_REF_PATTERN.test(submission.endpointRef)
  ) {
    return {
      valid: false,
      reason:
        "endpoint reference must be an opaque identifier (1..200 chars, no host-shaped paths)",
    };
  }
  if (refLooksLikeHostPath(submission.endpointRef)) {
    return {
      valid: false,
      reason: `"${submission.endpointRef}" looks like a host path; endpoint references are opaque identifiers resolved by the owning channel adapter`,
    };
  }
  if (!/^[\x21-\x7e]{16,256}$/.test(submission?.registrationToken ?? "")) {
    return {
      valid: false,
      reason:
        "registration token must be 16..256 printable characters (stored hashed, never returned)",
    };
  }
  if (containsRawSecretValue(submission?.registrationToken ?? "")) {
    return {
      valid: false,
      reason:
        "registration token looks like a raw platform/provider secret; runner registration tokens are opaque channel artifacts, never reused provider credentials",
    };
  }
  if (
    typeof submission?.submittedBy !== "string" ||
    !SUBMITTER_PATTERN.test(submission.submittedBy)
  ) {
    return {
      valid: false,
      reason: "submittedBy must be a non-empty printable identity (max 128 chars)",
    };
  }
  return { valid: true };
}

/** The neutral provenance carried onto the durable runner record. */
export function submissionProvenance(submission: ExternalRunnerRegistration): RunnerProvenance {
  return {
    actorId: submission.submittedBy,
    cause: "external-runner-registration",
    channel: "runners-gateway",
    registeredAt: new Date().toISOString(),
  };
}
