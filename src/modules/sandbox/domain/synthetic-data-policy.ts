/**
 * The synthetic-data policy artifact (sandbox module; DEP-014).
 *
 * The governed, versioned platform artifact that states what data
 * classes are permitted in sandboxes, how the admission path enforces
 * it, and how violations are recorded. ONE source of truth: the console
 * renders THIS artifact through the public policy route (never a
 * console-local copy); the sandbox admission enforces THIS policy's
 * permitted-class set; the DEP-013 composer consumes the same surface.
 *
 * Frozen and digest-carrying: the version identity is the content
 * digest — the policy document is append-only platform governance (a
 * new version is a new artifact, never an in-place rewrite).
 */

import { createHash } from "node:crypto";

/** The permitted data-class vocabulary (the allowlist admission enforces). */
export const SYNTHETIC_DATA_PERMITTED_CLASSES = [
  "synthetic-text",
  "synthetic-fixture-reference",
  "synthetic-numeric-parameter",
  "synthetic-vocabulary-item",
] as const;

export type SyntheticDataClass = (typeof SYNTHETIC_DATA_PERMITTED_CLASSES)[number];

export function isSyntheticDataClass(value: string): value is SyntheticDataClass {
  return (SYNTHETIC_DATA_PERMITTED_CLASSES as readonly string[]).includes(value);
}

/** The prohibited classes — named for the policy document, never guessed. */
export const SYNTHETIC_DATA_PROHIBITED_CLASSES = [
  "real-pii",
  "credentials",
  "secrets",
  "production-data",
  "real-world-identifiers",
] as const;

/** The policy document (the versioned artifact served verbatim). */
export interface SyntheticDataPolicyDocument {
  readonly artifact: "zeck-synthetic-data-policy";
  readonly version: string;
  readonly digest: string;
  readonly permittedClasses: readonly string[];
  readonly prohibitedClasses: readonly string[];
  readonly enforcement: readonly {
    readonly point: string;
    readonly behavior: string;
  }[];
  readonly violationRecording: string;
}

const POLICY_VERSION = "1";

const ENFORCEMENT: readonly { readonly point: string; readonly behavior: string }[] = [
  {
    point: "sandbox admission (policy admission, REQUIRED in the chain)",
    behavior:
      "A declared data class outside the permitted set refuses the admission fail-closed (POLICY_DENIED) — never a warning, never a default-allow.",
  },
  {
    point: "sandbox identity establishment and reset",
    behavior:
      "Establishing or resetting a disposable sandbox identity requires the declared data classes to sit inside the permitted set.",
  },
  {
    point: "console composer (DEP-013 surface)",
    behavior:
      "The playground composer constrains inputs to the synthetic corpus vocabulary and neutralizes real-world identifiers, credential-shaped material, markup and opaque blobs before any wire call.",
  },
];

function digestOf(): string {
  const canonical = JSON.stringify({
    artifact: "zeck-synthetic-data-policy",
    version: POLICY_VERSION,
    permittedClasses: SYNTHETIC_DATA_PERMITTED_CLASSES,
    prohibitedClasses: SYNTHETIC_DATA_PROHIBITED_CLASSES,
    enforcement: ENFORCEMENT,
    violationRecording:
      "Violations record facts only — the prohibited class and the deny decision. Payloads are never recorded, never logged, never rendered.",
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The ONE policy document instance (frozen at load; digest-carrying). */
export const SYNTHETIC_DATA_POLICY: SyntheticDataPolicyDocument = Object.freeze({
  artifact: "zeck-synthetic-data-policy",
  version: POLICY_VERSION,
  digest: digestOf(),
  permittedClasses: SYNTHETIC_DATA_PERMITTED_CLASSES,
  prohibitedClasses: SYNTHETIC_DATA_PROHIBITED_CLASSES,
  enforcement: ENFORCEMENT,
  violationRecording:
    "Violations record facts only — the prohibited class and the deny decision. Payloads are never recorded, never logged, never rendered.",
});

/**
 * The admission check: every declared class must sit inside the
 * permitted set. Absent declarations are an honest empty set (nothing
 * declared, nothing to check); an UNKNOWN declared class denies — the
 * check is fail-closed against inventories of convenience.
 */
export function syntheticDataClassesAdmitted(
  declared: readonly string[],
): { admitted: true } | { admitted: false; prohibited: string } {
  for (const candidate of declared) {
    if (!isSyntheticDataClass(candidate)) {
      return { admitted: false, prohibited: candidate };
    }
  }
  return { admitted: true };
}

/** A recorded policy violation: facts only (class + decision), never payloads. */
export interface SyntheticDataViolationFact {
  readonly applicationId: string;
  readonly prohibitedClass: string;
  readonly decision: "denied";
  readonly occurredAt: string;
}
