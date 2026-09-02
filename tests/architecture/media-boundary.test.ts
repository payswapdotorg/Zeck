/**
 * Architecture: the provider-neutral media-generation boundary
 * (WORK-026, MOD-011/012/013; checkpoint contracts
 * SELF-HOSTING-BOUNDARY, EXECUTION-PROVENANCE,
 * CONCURRENCY-CRASH-SAFETY).
 *
 * Mechanically proves over the REAL `src/modules/deployments/` tree and
 * migration 0021:
 *
 *  - MG1 the media rail port carries NO authority surface (MOD-011:
 *    replaceable upstream infrastructure): its METHOD set is exactly the
 *    transport trio {submitJob, cancelJob, pollJob}; no admission/
 *    authorize/budget/execute/invoke/dispatch-transition vocabulary, no
 *    authority type handles;
 *  - MG2 the rail port's shapes are coordinates-only: no store, policy,
 *    capability, budget or execution handles cross the seam; raw media
 *    payloads never cross (bounded descriptors + the content-digest
 *    artifact reference only); every side-effecting method carries the
 *    STABLE rail-level idempotency key; raw provider states never cross
 *    (the CLOSED normalized observation vocabulary + reference-only
 *    labels);
 *  - MG3 the REQUIRED admission seams exist with the frozen method
 *    vocabulary (admit / resolve / reserve+settle+release / mediate) plus
 *    the verification gate and the artifact authority — the media
 *    generation service cannot be constructed without them;
 *  - MG4 the media generation service deps are pinned: exactly {store,
 *    deployments, rail, policy, capabilities, budget, secrets, ledger,
 *    artifacts, verification, railConnectionRef, digest, generateId,
 *    now} — no additional authority handles are reachable;
 *  - MG5 migration 0021 is the media migration with the physical guards
 *    (job identity-core immutability + pinned plan version, the closed
 *    lifecycle machine + terminal immutability, the append-only
 *    observation ledger with the inbound idempotency UNIQUE + the
 *    no-payload-bytes shape guard, the write-once adoption records with
 *    lineage references, the verification-before-completion output
 *    projection, the durable recoverable operation state with
 *    attempts/checkpoint/terminal discipline) and the parallel-wave
 *    collision-rule discipline (0015 burned, WORK-026 claims 0021,
 *    sibling WORK-028 claims 0022);
 *  - MG6 provider neutrality: no media vendor identifier anywhere in the
 *    deployments tree (the provider-neutrality scanners extended to the
 *    media vocabulary);
 *  - MG7 the media domain and ports stay pure: no `src/platform/**`
 *    import in domain/ or ports/, no provider SDK imports, no
 *    node:crypto/node:http runtime imports in the domain;
 *  - MG8 the ledger adapter produces ONLY executions-owned step-event
 *    vocabulary (agent-session-started / agent-action-recorded /
 *    agent-session-completed) — the deployments tree owns none of the
 *    event vocabulary and writes no executions SQL;
 *  - MG9 no second media/execution state machine: the media store port
 *    never carries execution-transition vocabulary (execution status
 *    moves only through the executions public seam); a media job is an
 *    Execution, bound by execution_id reference, never a rival
 *    execution authority;
 *  - MG10 the durable recoverable operation state is STRUCTURAL in the
 *    store port: begin/checkpoint/complete/fail over a CLOSED operation
 *    vocabulary with stable keys — the crash-safety contract (the
 *    WORK-024 standard) is not an optional extension point.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER, RAIL_LITERAL } from "../discrimination/lib/patterns";

const REPO_ROOT = join(process.cwd());
const DEPLOYMENTS_DIR = join(REPO_ROOT, "src/modules/deployments");
const MIGRATION_PATH = join(REPO_ROOT, "src/platform/db/migrations/0021_media_generation_jobs.sql");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collectFiles(DEPLOYMENTS_DIR);
const MEDIA_FILES = FILES.filter((file) => /media/.test(file));

/** Authority-shaped method/type vocabulary that must never appear on a rail port. */
const AUTHORITY_VOCABULARY = [
  "admit(",
  "authorize(",
  "execute(",
  "invoke(",
  "transition(",
  "reserve(",
  "ToolAdmission",
  "BudgetAuthority",
  "ExecutionService",
  "ExecutionStore",
  "PolicyStore",
  "CapabilityRegistry",
  "SecretVault",
  "CredentialVault",
];

/** Media vendor identifiers (types, functions, variables, comments). */
const MEDIA_VENDOR_IDENTIFIER =
  /\b(OpenAI|DALL-?E|Stability|Midjourney|Runway|Pika|Suno|ElevenLabs|Replicate|Luma|Kling|openai|stability|midjourney|runway|pika|suno|elevenlabs|replicate|luma|kling)\w*/;

/** Media vendor names as rail slugs / string literals. */
const MEDIA_RAIL_LITERAL =
  /["'](openai|dall-e|stability|midjourney|runway|pika|suno|elevenlabs|replicate|luma|kling)["']/;

function read(relative: string): string {
  return readFileSync(join(DEPLOYMENTS_DIR, relative), "utf8");
}

const RAIL_PORT = read("ports/media-rail.ts");
const STORE_PORT = read("ports/media-store.ts");
const ADMISSION_PORT = read("ports/media-admission.ts");
const LEDGER_PORT = read("ports/media-execution-ledger.ts");
const ARTIFACT_PORT = read("ports/media-artifact-authority.ts");
const VERIFICATION_PORT = read("ports/media-verification.ts");
const SERVICE_SOURCE = read("application/media-generation-service.ts");
const DOMAIN_SOURCE = read("domain/media.ts");
const LEDGER_ADAPTER = read("adapters/media-execution-ledger.ts");
const MIGRATION_SOURCE = readFileSync(MIGRATION_PATH, "utf8");

/** The brace-balanced body of one named interface in a port source. */
function interfaceBody(source: string, name: string): string {
  const opener = `export interface ${name} {`;
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`interface not found: ${name}`);
  }
  let depth = 0;
  let end = -1;
  for (let index = start + opener.length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`interface body unterminated: ${name}`);
  }
  return source.slice(start + opener.length, end);
}

/** The method names of an interface (paren methods only, excluding the descriptor property). */
function methodNamesOf(source: string, name: string): string[] {
  const body = interfaceBody(source, name);
  return [
    ...new Set(
      [...body.matchAll(/^\s{2,}(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)]
        .map((match) => match[1] ?? "")
        .filter((method) => method !== "descriptor"),
    ),
  ].sort();
}

describe("architecture: the provider-neutral media-generation boundary (WORK-026)", () => {
  test("the media files are present and scanned", () => {
    expect(MEDIA_FILES.length).toBeGreaterThanOrEqual(20);
  });

  test("MG1: the media rail port's METHOD set is exactly the transport surface", () => {
    for (const forbidden of AUTHORITY_VOCABULARY) {
      expect(RAIL_PORT.includes(forbidden), `the rail port must not carry "${forbidden}"`).toBe(
        false,
      );
    }
    expect(methodNamesOf(RAIL_PORT, "MediaRail")).toEqual(["cancelJob", "pollJob", "submitJob"]);
    // The descriptor is the transport-class declaration only.
    expect(RAIL_PORT.includes('transportClass: "media-generation"')).toBe(true);
    // The descriptor declares the per-kind pricing (the budget amount
    // source — the adapter's knowledge, never a caller assertion).
    expect(RAIL_PORT.includes("generationCostMicroUsd")).toBe(true);
  });

  test("MG2: the rail port's shapes are coordinates-only with stable keys and closed vocabularies", () => {
    for (const forbidden of [
      "MediaStore",
      "MediaPolicyAdmission",
      "MediaBudgetAdmission",
      "MediaExecutionLedger",
      "policy",
      "budget",
    ]) {
      expect(
        RAIL_PORT.includes(`${forbidden};`),
        `coordinates only: no "${forbidden}" handle`,
      ).toBe(false);
    }
    // Every side-effecting method carries the STABLE idempotency key.
    const dispatchRequest = interfaceBody(RAIL_PORT, "MediaRailDispatchRequest");
    expect(dispatchRequest.includes("readonly idempotencyKey: string;")).toBe(true);
    const cancelRequest = interfaceBody(RAIL_PORT, "MediaRailCancelRequest");
    expect(cancelRequest.includes("readonly idempotencyKey: string;")).toBe(true);
    // The dispatch carries the ARTIFACT REFERENCE, never media bytes.
    expect(dispatchRequest.includes("readonly inputArtifactDigest: string | null;")).toBe(true);
    for (const payloadField of ["payload: string", "payloadBase64", "mediaBytes", "rawBytes"]) {
      expect(
        dispatchRequest.includes(payloadField),
        "payload fields never cross the rail seam",
      ).toBe(false);
    }
    // The provider reference is OPAQUE evidence, never the identity.
    expect(dispatchRequest.includes("readonly spec: Readonly<Record<string, unknown>>;")).toBe(
      true,
    );
    // Raw provider states never cross: polls and callbacks carry the
    // CLOSED normalized observation vocabulary + reference-only labels.
    expect(RAIL_PORT.includes("MediaProviderObservation")).toBe(true);
    const poll = interfaceBody(RAIL_PORT, "MediaRailPollOutcome");
    expect(poll.includes("readonly observation: MediaProviderObservation;")).toBe(true);
    const callback = interfaceBody(RAIL_PORT, "MediaRailJobCallback");
    expect(callback.includes("readonly observation: MediaProviderObservation;")).toBe(true);
    // Outputs are bounded artifact-reference descriptors (the digest
    // reference), never payloads.
    expect(poll.includes("outputDescriptor: Readonly<Record<string, unknown>> | null;")).toBe(true);
  });

  test("MG3: the REQUIRED admission seams exist with the frozen method vocabulary", () => {
    expect(methodNamesOf(ADMISSION_PORT, "MediaPolicyAdmission")).toEqual(["admit"]);
    expect(methodNamesOf(ADMISSION_PORT, "MediaCapabilityAdmission")).toEqual(["resolve"]);
    expect(methodNamesOf(ADMISSION_PORT, "MediaBudgetAdmission")).toEqual([
      "release",
      "reserve",
      "settle",
    ]);
    expect(methodNamesOf(ADMISSION_PORT, "MediaSecretMediation")).toEqual(["mediate"]);
    // The admission chain is over the media actions (job-submit /
    // job-cancel / variant-derive) — the neutral action vocabulary.
    expect(ADMISSION_PORT.includes('"job-submit"')).toBe(true);
    expect(ADMISSION_PORT.includes('"job-cancel"')).toBe(true);
    expect(ADMISSION_PORT.includes('"variant-derive"')).toBe(true);
    // The verification gate + the artifact authority are REQUIRED
    // (verification-before-completion + MOD-012 lineage).
    expect(methodNamesOf(VERIFICATION_PORT, "MediaVerificationGate")).toEqual(["verify"]);
    expect(ARTIFACT_PORT.includes("adoptArtifact")).toBe(true);
    expect(ARTIFACT_PORT.includes("artifactExists")).toBe(true);
  });

  test("MG4: the media generation service deps are pinned (no extra authority handles)", () => {
    const body = interfaceBody(SERVICE_SOURCE, "MediaGenerationServiceDeps");
    const deps = [
      ...new Set([...body.matchAll(/^\s*readonly\s+([A-Za-z_]\w*):/gm)].map((m) => m[1] ?? "")),
    ].sort();
    expect(deps).toEqual([
      "artifacts",
      "budget",
      "capabilities",
      "deployments",
      "digest",
      "generateId",
      "ledger",
      "now",
      "policy",
      "rail",
      "railConnectionRef",
      "secrets",
      "store",
      "verification",
    ]);
    // The service consults every REQUIRED admission seam (the frozen
    // order is proven in the discrimination suite S2).
    for (const seam of [
      "policy.admit(",
      "capabilities.resolve(",
      "budget.reserve(",
      "secrets.mediate(",
    ]) {
      expect(new RegExp(seam.replace(/[.()]/g, "\\$&")).test(SERVICE_SOURCE)).toBe(true);
    }
    // The service consults the verification gate and the artifact
    // authority (AC5/MOD-012).
    expect(/verification\s*\.\s*verify\(/.test(SERVICE_SOURCE)).toBe(true);
    expect(/artifacts\s*\.\s*adoptArtifact\(/.test(SERVICE_SOURCE)).toBe(true);
    expect(/artifacts\s*\.\s*artifactExists\(/.test(SERVICE_SOURCE)).toBe(true);
  });

  test("MG5: migration 0021 is the media migration with the physical guard set", () => {
    // The migration-claim discipline (the parallel-wave collision rule).
    expect(MIGRATION_SOURCE.includes("WORK-026 claims\n-- 0021")).toBe(true);
    expect(MIGRATION_SOURCE.includes("0015 is\n-- BURNED")).toBe(true);
    expect(MIGRATION_SOURCE.includes("WORK-028 claims 0022")).toBe(true);
    // The media jobs lifecycle machine + terminal immutability.
    expect(MIGRATION_SOURCE.includes("media_jobs_status_vocabulary")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_jobs_lifecycle")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_jobs_terminal")).toBe(true);
    expect(MIGRATION_SOURCE.includes("terminal-immutable")).toBe(true);
    // The identity core is write-once (pinned plan version, execution
    // identity, submission key, verification policy).
    expect(MIGRATION_SOURCE.includes("media_jobs_core_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("NEW.pinned_plan_version <> OLD.pinned_plan_version")).toBe(
      true,
    );
    expect(MIGRATION_SOURCE.includes("NEW.execution_id <> OLD.execution_id")).toBe(true);
    // Duplicate submission arbitration + no deletes.
    expect(MIGRATION_SOURCE.includes("media_jobs_submission_key_unique")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_jobs_no_delete_guard")).toBe(true);
    // The append-only observation ledger + the inbound idempotency.
    expect(MIGRATION_SOURCE.includes("media_obs_key_unique")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_obs_append_only_guard")).toBe(true);
    // Raw payload bytes never ride descriptors.
    expect(MIGRATION_SOURCE.includes("must not carry raw payload bytes")).toBe(true);
    // The write-once adoption records + lineage reference discipline.
    expect(MIGRATION_SOURCE.includes("media_art_immutable_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_art_key_unique")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_art_parents_refs_guard")).toBe(true);
    // The verification-before-completion output projection.
    expect(MIGRATION_SOURCE.includes("media_jobs_output_projection_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("outputs attach only at completion")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_jobs_completed_has_output")).toBe(true);
    // The durable recoverable operation state (the WORK-024 standard).
    expect(MIGRATION_SOURCE.includes("media_ops_key_unique")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_ops_lifecycle_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_ops_core_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("media_ops_no_delete_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("attempts >= 1")).toBe(true);
  });

  test("MG6: provider neutrality — no media vendor identifier anywhere in the deployments tree", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const relative = file.slice(DEPLOYMENTS_DIR.length + 1);
      expect(MEDIA_VENDOR_IDENTIFIER.test(source), `media vendor identifier in ${relative}`).toBe(
        false,
      );
      expect(MEDIA_RAIL_LITERAL.test(source), `media vendor literal in ${relative}`).toBe(false);
      expect(PROVIDER_IDENTIFIER.test(source), `provider identifier in ${relative}`).toBe(false);
      expect(RAIL_LITERAL.test(source), `provider rail literal in ${relative}`).toBe(false);
    }
  });

  test("MG7: the media domain and ports stay pure (no platform or SDK imports)", () => {
    for (const dir of ["domain", "ports"]) {
      for (const file of FILES.filter((candidate) => candidate.includes(`/${dir}/`))) {
        const source = readFileSync(file, "utf8");
        const relative = file.slice(DEPLOYMENTS_DIR.length + 1);
        const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
          (match) => match[1] ?? "",
        );
        for (const specifier of importSpecifiers) {
          expect(
            specifier.startsWith("../..") && specifier.includes("/platform"),
            `platform import ${specifier} in ${relative}`,
          ).toBe(false);
          expect(
            specifier.startsWith("node:") && specifier !== "node:crypto",
            `runtime import ${specifier} in ${relative}`,
          ).toBe(false);
          expect(
            ["pg", "fastify", "http", "net", "fs"].includes(specifier),
            `infra import ${specifier} in ${relative}`,
          ).toBe(false);
          // Cross-MODULE imports go through public barrels only (the
          // shared module is not a module barrel).
          if (specifier.includes("/modules/") && specifier.startsWith("../")) {
            expect(
              specifier.endsWith("/public"),
              `non-public cross-module import in ${relative}`,
            ).toBe(true);
          }
        }
      }
    }
    // The domain module is pure (the deterministic pre/postprocessing).
    expect(DOMAIN_SOURCE.includes('from "node:crypto"')).toBe(false);
  });

  test("MG8: the ledger adapter produces ONLY executions-owned step-event vocabulary", () => {
    // The evidence-class → command mapping exists and every mapped
    // command is the executions vocabulary.
    const mapping = /const CLASS_TO_COMMAND[^=]*=\s*\{([\s\S]*?)\};/.exec(LEDGER_ADAPTER)?.[1];
    expect(mapping).toBeDefined();
    const commands = [
      ...new Set([...(mapping ?? "").matchAll(/:\s*"(agent-[\w-]+)"/g)].map((m) => m[1] ?? "")),
    ].sort();
    expect(commands).toEqual([
      "agent-action-recorded",
      "agent-session-completed",
      "agent-session-started",
    ]);
    // The adapter rides the executions PUBLIC service only.
    expect(LEDGER_ADAPTER.includes("ExecutionService")).toBe(true);
    expect(LEDGER_ADAPTER.includes("service.recordStepEvent(")).toBe(true);
    expect(LEDGER_ADAPTER.includes("service.transition(")).toBe(true);
    expect(LEDGER_ADAPTER.includes("service.createExecution(")).toBe(true);
    // The RUNNING walk uses the executions transition vocabulary only.
    const walk = /const PRE_RUNNING_WALK[\s\S]*?\];/.exec(LEDGER_ADAPTER)?.[0] ?? "";
    for (const command of ['"authorize"', '"plan"', '"queue"', '"start"']) {
      expect(walk.includes(command), `the walk must use the executions ${command} transition`).toBe(
        true,
      );
    }
    // No executions SQL in the deployments tree.
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("executions.execution")).toBe(false);
    }
  });

  test("MG9: no second media/execution state machine (the structural gate)", () => {
    for (const forbidden of [
      "transitionExecution",
      "setExecutionStatus",
      "writeExecutionState",
      "updateExecution",
      "executionStatus(",
    ]) {
      expect(STORE_PORT.includes(forbidden), `execution authority inversion: ${forbidden}`).toBe(
        false,
      );
    }
    // The job's execution binding is a REFERENCE (the executions public
    // seam drives lifecycle transitions).
    const jobRecord = interfaceBody(DOMAIN_SOURCE, "MediaJobRecord");
    expect(jobRecord.includes("readonly executionId: string;")).toBe(true);
    // The provenance path exists through the ledger port (recordEvidence).
    expect(methodNamesOf(LEDGER_PORT, "MediaExecutionLedger")).toContain("recordEvidence");
    expect(/ledger\s*\.\s*recordEvidence\(/.test(SERVICE_SOURCE)).toBe(true);
    // The media store never writes the executions tables; the ledger
    // adapter owns the transition vocabulary through the public seam.
    expect(methodNamesOf(LEDGER_PORT, "MediaExecutionLedger")).toContain("openExecution");
    expect(methodNamesOf(LEDGER_PORT, "MediaExecutionLedger")).toContain("enterVerification");
    expect(methodNamesOf(LEDGER_PORT, "MediaExecutionLedger")).toContain("completeExecution");
  });

  test("MG10: the durable recoverable operation state is structural in the store port", () => {
    const store = methodNamesOf(STORE_PORT, "MediaStore");
    for (const required of [
      "appendObservation",
      "applyGuardedJobMutation",
      "beginMediaOperation",
      "completeMediaOperation",
      "failMediaOperation",
      "findMediaOperation",
      "insertArtifact",
      "insertJob",
      "recordMediaOperationCheckpoint",
    ]) {
      expect(store, `the store must carry ${required}`).toContain(required);
    }
    // The CLOSED operation vocabulary + the closed operation status
    // machine are domain-owned constants.
    expect(DOMAIN_SOURCE.includes("MEDIA_OPERATION_KINDS")).toBe(true);
    expect(DOMAIN_SOURCE.includes("MEDIA_OPERATION_STATUSES")).toBe(true);
    expect(DOMAIN_SOURCE.includes("job-submission")).toBe(true);
    expect(DOMAIN_SOURCE.includes("paid-dispatch")).toBe(true);
    expect(DOMAIN_SOURCE.includes("observation-apply")).toBe(true);
    expect(DOMAIN_SOURCE.includes("job-completion")).toBe(true);
    expect(DOMAIN_SOURCE.includes("job-cancellation")).toBe(true);
    expect(DOMAIN_SOURCE.includes("variant-adoption")).toBe(true);
    // The STABLE rail-level idempotency keys + the budget/verification
    // operation keys are domain functions (job-stable discriminators).
    for (const keyFn of [
      "mediaRailDispatchKey",
      "mediaRailCancelKey",
      "mediaBudgetOperationId",
      "mediaVerificationKey",
      "mediaOperationKey",
      "mediaOutputArtifactKey",
      "mediaVariantArtifactKey",
      "mediaEvidenceKey",
    ]) {
      expect(DOMAIN_SOURCE.includes(`function ${keyFn}(`), `${keyFn} must be domain-owned`).toBe(
        true,
      );
    }
  });
});
