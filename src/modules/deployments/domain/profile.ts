/**
 * Deployment profile domain (deployments module domain; WORK-023,
 * MOD-001, ADR-0014/0015/0017).
 *
 * The provider-neutral, IMMUTABLE VERSIONED declaration of WHAT a
 * deployment requires — channels/modalities, capabilities, latency and
 * resource characteristics, side-effect class and external integration
 * needs. It is the deployment-fabric twin of the agent version
 * artifact (WORK-011): write-once per version, content-addressed,
 * promoted/rolled back through journal APPENDS, never rewritten.
 *
 * Provider neutrality is structural (MOD-001/ADR-0014 invariant):
 * the profile names provider-neutral CHANNEL KINDS and NEUTRAL
 * capability identifiers — never a vendor, a rail slug or an SDK
 * shape. Concrete infrastructure is selected downstream through the
 * replaceable modality-adapter seam (ports/modality-adapter.ts),
 * exactly as model rails stay behind the models adapters.
 *
 * It is NOT an authority: no policy, capability-grant, budget,
 * execution or verification decision lives here. A profile DESCRIBES
 * requirements; the existing authorities decide admission at
 * execution time (the same chain every execution already passes).
 */

/**
 * The deployment-modality vocabulary (ADR-0014's profile model).
 * Exactly the ADR's initial set plus the roadmap's background
 * automation and the explicit future-profile escape hatch (`custom`
 * keeps new modalities representable without a vocabulary change
 * until they earn a first-class kind).
 */
export const DEPLOYMENT_MODALITIES = [
  "realtime-voice",
  "messaging",
  "media-generation",
  "document-vision",
  "realtime-multimodal",
  "background-automation",
  "custom",
] as const;
export type DeploymentModality = (typeof DEPLOYMENT_MODALITIES)[number];

/**
 * Provider-neutral channel kinds a profile may require (ADR-0014/0015:
 * web, telephony, messaging networks, in-app…). Concrete rails
 * (WORK-024/025/026) bind to these kinds through adapters — vendor
 * identifiers never cross this contract.
 */
export const DEPLOYMENT_CHANNEL_KINDS = [
  "web",
  "in-app",
  "telephony",
  "sms",
  "email",
  "webhook",
] as const;
export type DeploymentChannelKind = (typeof DEPLOYMENT_CHANNEL_KINDS)[number];

/**
 * Deployment-level latency expectations (ADR-0014 "latency/resource
 * characteristics"). Deliberately a DEPLOYMENT concern, distinct from
 * the workload-class contracts WORK-031 owns in its own surfaces.
 */
export const DEPLOYMENT_LATENCY_CLASSES = ["realtime", "interactive", "asynchronous"] as const;
export type DeploymentLatencyClass = (typeof DEPLOYMENT_LATENCY_CLASSES)[number];

/** Resource weight classes (the profile's resource characteristic). */
export const DEPLOYMENT_RESOURCE_CLASSES = ["light", "standard", "heavy", "accelerated"] as const;
export type DeploymentResourceClass = (typeof DEPLOYMENT_RESOURCE_CLASSES)[number];

/** Side-effect classes — the tools vocabulary, reused by declaration. */
export const DEPLOYMENT_SIDE_EFFECT_CLASSES = ["none", "read-only", "write-external"] as const;
export type DeploymentSideEffectClass = (typeof DEPLOYMENT_SIDE_EFFECT_CLASSES)[number];

/** Input/output modality atoms a profile may declare. */
export const DEPLOYMENT_IO_MODALITIES = ["text", "audio", "image", "video", "document"] as const;
export type DeploymentIoModality = (typeof DEPLOYMENT_IO_MODALITIES)[number];

/** The immutable versioned profile artifact. */
export interface DeploymentProfile {
  /** Caller-chosen stable identity slug (unique per application). */
  readonly profileId: string;
  /** Monotonic version of this profile identity (starts at 1). */
  readonly version: number;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly modality: DeploymentModality;
  /** Provider-neutral channel kinds the deployment requires. */
  readonly channelKinds: readonly DeploymentChannelKind[];
  /** Neutral capability identifiers the deployed agent needs. */
  readonly requiredCapabilities: readonly string[];
  readonly latencyClass: DeploymentLatencyClass;
  readonly resourceClass: DeploymentResourceClass;
  readonly sideEffectClass: DeploymentSideEffectClass;
  /** Input/output modality atoms. */
  readonly inputModalities: readonly DeploymentIoModality[];
  readonly outputModalities: readonly DeploymentIoModality[];
  /**
   * Human intent (never a secret; bounded; secret-shaped content is
   * rejected by validation — the WORK-011 free-text discipline).
   */
  readonly description: string | null;
  /** Content digest over the canonical profile body. */
  readonly digest: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The publishable body (identity + declaration, before persistence). */
export interface DeploymentProfileInput {
  readonly profileId: string;
  readonly modality: DeploymentModality;
  readonly channelKinds: readonly DeploymentChannelKind[];
  readonly requiredCapabilities: readonly string[];
  readonly latencyClass: DeploymentLatencyClass;
  readonly resourceClass: DeploymentResourceClass;
  readonly sideEffectClass: DeploymentSideEffectClass;
  readonly inputModalities: readonly DeploymentIoModality[];
  readonly outputModalities: readonly DeploymentIoModality[];
  readonly description?: string;
}

export type ProfileValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const MAX_CAPABILITIES = 32;
const MAX_DESCRIPTION = 2000;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function profileContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Pure, fail-closed validation of a profile body. Vocabularies are
 * frozen, duplicates rejected, arrays bounded, free-text
 * secret-scanned — a malformed declaration never becomes durable
 * state (the validate-before-durability discipline of every module).
 */
export function validateDeploymentProfileInput(input: unknown): ProfileValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, reason: "profile input must be an object" };
  }
  const p = input as unknown as DeploymentProfileInput;
  if (typeof p.profileId !== "string" || !IDENTITY_PATTERN.test(p.profileId)) {
    return { valid: false, reason: "profileId must be a lowercase hyphen-dashed identifier" };
  }
  if (
    typeof p.modality !== "string" ||
    !(DEPLOYMENT_MODALITIES as readonly string[]).includes(p.modality)
  ) {
    return { valid: false, reason: `modality must be one of ${DEPLOYMENT_MODALITIES.join("|")}` };
  }
  if (!Array.isArray(p.channelKinds) || p.channelKinds.length === 0) {
    return {
      valid: false,
      reason: "channelKinds must declare at least one provider-neutral channel kind",
    };
  }
  if (new Set(p.channelKinds).size !== p.channelKinds.length) {
    return { valid: false, reason: "channelKinds must not contain duplicates" };
  }
  for (const kind of p.channelKinds) {
    if (
      typeof kind !== "string" ||
      !(DEPLOYMENT_CHANNEL_KINDS as readonly string[]).includes(kind)
    ) {
      return {
        valid: false,
        reason: `channel kind "${String(kind)}" is not in the neutral vocabulary`,
      };
    }
  }
  if (!Array.isArray(p.requiredCapabilities) || p.requiredCapabilities.length > MAX_CAPABILITIES) {
    return {
      valid: false,
      reason: `requiredCapabilities must be an array of at most ${MAX_CAPABILITIES} entries`,
    };
  }
  for (const capability of p.requiredCapabilities) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      return {
        valid: false,
        reason: `capability "${String(capability)}" is not a neutral capability identifier`,
      };
    }
  }
  if (new Set(p.requiredCapabilities).size !== p.requiredCapabilities.length) {
    return { valid: false, reason: "requiredCapabilities must not contain duplicates" };
  }
  if (
    typeof p.latencyClass !== "string" ||
    !(DEPLOYMENT_LATENCY_CLASSES as readonly string[]).includes(p.latencyClass)
  ) {
    return {
      valid: false,
      reason: `latencyClass must be one of ${DEPLOYMENT_LATENCY_CLASSES.join("|")}`,
    };
  }
  if (
    typeof p.resourceClass !== "string" ||
    !(DEPLOYMENT_RESOURCE_CLASSES as readonly string[]).includes(p.resourceClass)
  ) {
    return {
      valid: false,
      reason: `resourceClass must be one of ${DEPLOYMENT_RESOURCE_CLASSES.join("|")}`,
    };
  }
  if (
    typeof p.sideEffectClass !== "string" ||
    !(DEPLOYMENT_SIDE_EFFECT_CLASSES as readonly string[]).includes(p.sideEffectClass)
  ) {
    return {
      valid: false,
      reason: `sideEffectClass must be one of ${DEPLOYMENT_SIDE_EFFECT_CLASSES.join("|")}`,
    };
  }
  for (const [field, value] of [
    ["inputModalities", p.inputModalities],
    ["outputModalities", p.outputModalities],
  ] as const) {
    if (!Array.isArray(value)) {
      return { valid: false, reason: `${field} must be an array` };
    }
    for (const atom of value) {
      if (
        typeof atom !== "string" ||
        !(DEPLOYMENT_IO_MODALITIES as readonly string[]).includes(atom)
      ) {
        return {
          valid: false,
          reason: `${field} entry "${String(atom)}" is not a neutral I/O modality`,
        };
      }
    }
    if (new Set(value).size !== value.length) {
      return { valid: false, reason: `${field} must not contain duplicates` };
    }
  }
  if (
    p.description !== undefined &&
    (typeof p.description !== "string" || p.description.length > MAX_DESCRIPTION)
  ) {
    return { valid: false, reason: `description must be at most ${MAX_DESCRIPTION} characters` };
  }
  if (p.description !== undefined && profileContainsRawSecretValue(p.description)) {
    return { valid: false, reason: "description looks like it embeds a raw secret value" };
  }
  return { valid: true };
}

/**
 * Deterministic canonical JSON of the profile body (sorted keys
 * recursively; vocabularies normalized to sorted unique lists) — the
 * content-addressing base. The same declaration digests identically
 * under any key order.
 */
export function canonicalProfileJson(input: DeploymentProfileInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return value;
  };
  return JSON.stringify([
    "deployments.profile",
    input.modality,
    uniqueSorted(input.channelKinds),
    uniqueSorted(input.requiredCapabilities),
    input.latencyClass,
    input.resourceClass,
    input.sideEffectClass,
    uniqueSorted(input.inputModalities.map(String)),
    uniqueSorted(input.outputModalities.map(String)),
    canonical(input.description ?? null),
  ]);
}
