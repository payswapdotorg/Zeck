/**
 * Shared public-surface scanners (WORK-015 discrimination, M1–M26).
 *
 * One definition of each protection, two uses — the architecture gate
 * runs the rules over the REAL trees, and the discrimination proofs
 * mutate the REAL source and require the scanners to flag exactly the
 * weakened protection (the WORK-005/013/014 red-record pattern).
 */

import { PROVIDER_IDENTIFIER } from "./patterns";

export interface SurfaceFile {
  readonly path: string;
  readonly content: string;
}

const API_IMPORT_OK =
  /from\s+["']\.\.\/(\.\.\/)?(modules\/[a-z0-9-]+\/public|shared\/[a-z0-9-]+)\.ts?["']/;
const SQL_PATTERN =
  /\b(INSERT INTO|UPDATE\s+[a-z]+\.[a-z_]+|DELETE FROM)\b|\bfrom\s+["'](pg|postgres)["']/;
const CLIENT_TENANT_TRUST = /body\.tenantId|body\[.tenantId.\]|query\.tenantId|tenantId\s*=\s*body/;
const CREATE_BODY_SPREAD = /\.\.\.body|\.\.\.request\.body|\.\.\.parsed/;

export function publicSurfaceViolations(files: readonly SurfaceFile[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const isApi = file.path.startsWith("src/api/");
    const isPublicProduct =
      file.path.startsWith("sdk/") || file.path.startsWith("cli/") || file.path.startsWith("apps/");

    if (isApi) {
      for (const match of file.content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith("./")) {
          // Local intra-api imports are fine (the api's own files).
          continue;
        }
        // Normalize to a repo-relative resolved path.
        const from = file.path.split("/").slice(0, -1);
        for (const segment of specifier.split("/")) {
          if (segment === "..") {
            from.pop();
          } else if (segment === ".") {
          } else if (segment.endsWith(".ts")) {
            from.push(segment.slice(0, -3));
          } else {
            from.push(segment);
          }
        }
        const resolved = from.join("/");
        const segments = resolved.split("/");
        const isModuleBarrel =
          segments.length === 4 &&
          segments[0] === "src" &&
          segments[1] === "modules" &&
          segments[3] === "public";
        const isShared = resolved.startsWith("src/shared/");
        const isIntraApi = resolved.startsWith("src/api/");
        if (!isModuleBarrel && !isShared && !isIntraApi) {
          violations.push(`api-boundary-bypass:${file.path}:${specifier}`);
        }
        void API_IMPORT_OK;
      }
      // M13: no SQL in the api layer.
      if (SQL_PATTERN.test(file.content)) {
        violations.push(`api-sql:${file.path}`);
      }
      // M2/M3: no client tenant trust.
      if (CLIENT_TENANT_TRUST.test(file.content)) {
        violations.push(`client-tenant-trust:${file.path}`);
      }
      // M11/M12: create body must parse a closed vocabulary, never spread.
      if (file.path.endsWith("routes/executions.ts") && CREATE_BODY_SPREAD.test(file.content)) {
        violations.push(`create-body-spread:${file.path}`);
      }
    }

    if (isApi || isPublicProduct) {
      // M17/M18: provider identifiers must not appear.
      if (PROVIDER_IDENTIFIER.test(file.content)) {
        violations.push(`provider-identifier:${file.path}`);
      }
      // M13-adjacent: no module internals from the product surfaces.
      if (isPublicProduct) {
        for (const match of file.content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
          const specifier = match[1] ?? "";
          if (
            specifier.includes("/internal/") ||
            /src\/(platform|modules)/.test(specifier) === false
          ) {
            if (specifier.includes("/internal/")) {
              violations.push(`internal-import:${file.path}:${specifier}`);
            }
          }
        }
      }
    }
  }

  return violations;
}

/** Planner-order-style scanner for the create route's scope resolution. */
export function createRouteScopeViolations(routeSource: string): string[] {
  const violations: string[] = [];
  // The scope MUST be resolved through the scope resolver (server-side),
  // BEFORE any authority call, and from the validated body applicationId.
  const hasResolver = routeSource.includes("resolveRequestIdentity");
  if (!hasResolver) {
    violations.push("missing-server-side-scope-resolution");
  }
  // The create route must reject unknown body keys (M2/M3).
  if (!routeSource.includes("unknown keys")) {
    violations.push("missing-closed-create-vocabulary");
  }
  // The cancel route must go through the transition authority (M26).
  if (!routeSource.includes('command: "cancel"')) {
    violations.push("cancel-bypasses-lifecycle");
  }
  return violations;
}

/** The serializer boundary scanner (M4–M8). */
export function serializerViolations(serializationSource: string): string[] {
  const violations: string[] = [];
  if (!serializationSource.includes("scrubSecretShapedKeys")) {
    violations.push("scrub-guard-removed");
  }
  if (!serializationSource.includes("REDACT_KEY_PATTERN")) {
    violations.push("redact-vocabulary-removed");
  }
  for (const fn of [
    "toWireExecution",
    "toWireReceipt",
    "toWireEvent",
    "toWireVerification",
    "toWireAgentSummary",
    "toWireAgentVersion",
    "toWirePromotion",
    "toWireAgentStatus",
  ]) {
    const fnSource = new RegExp(`function ${fn}\\(`).exec(serializationSource);
    if (fnSource === null) {
      violations.push(`serializer-missing:${fn}`);
      continue;
    }
    const body = serializationSource.slice(fnSource.index ?? 0, (fnSource.index ?? 0) + 2000);
    if (/return\s*\{\s*\.\.\.(record|receipt|envelope|agent|version|selection)\b/.test(body)) {
      violations.push(`serializer-spreads-domain-record:${fn}`);
    }
  }
  return violations;
}

/** The webhook delivery scanner (M8/M9/M10). */
export function webhookDeliveryViolations(deliverySource: string): string[] {
  const violations: string[] = [];
  if (!deliverySource.includes("signWebhookEvent")) {
    violations.push("signing-removed");
  }
  // The signature header must be attached on EVERY attempt (M9).
  if (!deliverySource.includes("[WEBHOOK_SIGNATURE_HEADER]: signature")) {
    violations.push("unsigned-delivery-path");
  }
  // The envelope must carry the full identity set (M10) — the anchors
  // are checked in the RETURNED envelope object (not the parameters).
  const envelopeReturn =
    /export function buildWebhookEvent[\s\S]*?return \{([\s\S]*?)\};/.exec(deliverySource)?.[1] ??
    "";
  for (const anchor of ["schemaVersion", "eventId", "attempt", "deliveredAt", "sequence"]) {
    if (!envelopeReturn.includes(anchor)) {
      violations.push(`envelope-missing:${anchor}`);
    }
  }
  // The secret must never be serialized into the payload (M8): the
  // returned envelope object must not reference the secret at all.
  if (/\bsecret\b/.test(envelopeReturn)) {
    violations.push("secret-in-payload");
  }
  return violations;
}

/** The error-mapper scanner (M25). */
export function errorMapperViolations(mapperSource: string): string[] {
  const violations: string[] = [];
  // The unknown-error path must fail closed to a disclosure-free body.
  if (!mapperSource.includes("no further detail is exposed")) {
    violations.push("unknown-error-leaks-internals");
  }
  if (/\.stack|\.cause\)/.test(mapperSource)) {
    violations.push("stack-or-cause-serialized");
  }
  return violations;
}
