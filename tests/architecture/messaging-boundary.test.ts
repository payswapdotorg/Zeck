/**
 * Architecture: the provider-neutral messaging boundary (WORK-025,
 * MOD-008/009; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE).
 *
 * Mechanically proves over the REAL `src/modules/deployments/` tree and
 * migration 0020:
 *
 *  - MG1 the messaging rail port carries NO authority surface (MOD-008:
 *    replaceable upstream infrastructure): its METHOD set is exactly the
 *    transport quartet {openConversation, sendMessage, escalate,
 *    closeConversation}; no admission/authorize/budget/execute/invoke/
 *    dispatch/transition vocabulary, no authority type handles;
 *  - MG2 the rail port's shapes are coordinates-only: no store, policy,
 *    capability, budget or execution handles cross the seam; raw
 *    payloads and attachments never cross (artifact references +
 *    bounded previews only); every side-effecting method carries the
 *    STABLE rail-level idempotency key;
 *  - MG3 the REQUIRED admission seams exist with the frozen method
 *    vocabulary (admit / resolve / reserve+settle+release / mediate) —
 *    the conversation service cannot be constructed without them;
 *  - MG4 the messaging conversation service deps are pinned: exactly
 *    {store, deployments, rail, policy, capabilities, budget, secrets,
 *    router, responder, ledger, railConnectionRef, digest, generateId,
 *    now} — no additional authority handles are reachable;
 *  - MG5 migration 0020 is the messaging migration with the physical
 *    guards (conversation identity-core immutability + pinned plan
 *    version, the frozen conversation lifecycle machine, the append-only
 *    message ledger with the inbound idempotency UNIQUE + the guarded
 *    monotonic delivery projection, the correlated append-only delivery
 *    evidence, the write-once escalation records, the durable
 *    recoverable operation state) and the parallel-wave collision-rule
 *    discipline (0015 burned, sibling 0021 claims 0019, WORK-025 claims
 *    0020);
 *  - MG6 provider neutrality: no messaging vendor identifier anywhere
 *    in the deployments tree (the provider-neutrality scanners extended
 *    to the messaging vocabulary);
 *  - MG7 the messaging domain and ports stay pure: no `src/platform/**`
 *    import in domain/ or ports/, no provider SDK imports;
 *  - MG8 the ledger adapter produces ONLY executions-owned step-event
 *    vocabulary (agent-session-started / agent-action-recorded /
 *    agent-session-completed) — the deployments tree owns none of the
 *    event vocabulary and writes no executions SQL.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER } from "../discrimination/lib/patterns";
import { collectSourceFiles } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = join(process.cwd());
const DEPLOYMENTS_DIR = join(REPO_ROOT, "src/modules/deployments");

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
const MESSAGING_FILES = FILES.filter((file) =>
  /messaging|in-process-messaging/.test(file),
);

/** Authority-shaped method/type vocabulary that must never appear on a rail port. */
const AUTHORITY_VOCABULARY = [
  "admit(",
  "authorize(",
  "execute(",
  "invoke(",
  "dispatch(",
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

describe("architecture: the provider-neutral messaging boundary (WORK-025)", () => {
  test("the messaging files are present and scanned", () => {
    expect(MESSAGING_FILES.length).toBeGreaterThanOrEqual(12);
  });

  test("MG1: the rail port's METHOD set is exactly the transport surface", () => {
    const port = readFileSync(join(DEPLOYMENTS_DIR, "ports/messaging-rail.ts"), "utf8");
    for (const forbidden of AUTHORITY_VOCABULARY) {
      expect(port.includes(forbidden), `the rail port must not carry "${forbidden}"`).toBe(false);
    }
    const interfaceBody = /export interface MessagingRail \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    const methodNames = [...interfaceBody.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)]
      .map((m) => m[1] ?? "")
      .filter((name) => name !== "descriptor");
    expect([...new Set(methodNames)].sort()).toEqual([
      "closeConversation",
      "escalate",
      "openConversation",
      "sendMessage",
    ]);
    // The descriptor is the transport-class declaration only.
    expect(port.includes('transportClass: "messaging"')).toBe(true);
    // The callback frames carry coordinates + bounded payload only.
    const messageCallback = /export interface MessagingRailMessageCallback \{([\s\S]*?)\n\}/.exec(
      port,
    )?.[1] ?? "";
    expect(messageCallback.includes("channelConversationRef")).toBe(true);
    expect(messageCallback.includes("eventKey")).toBe(true);
    const deliveryCallback = /export interface MessagingRailDeliveryCallback \{([\s\S]*?)\n\}/.exec(
      port,
    )?.[1] ?? "";
    expect(deliveryCallback.includes("messageKey")).toBe(true);
    expect(deliveryCallback.includes("callbackKey")).toBe(true);
  });

  test("MG2: the rail port's shapes are coordinates-only (no authority handles, no raw payloads, stable keys everywhere)", () => {
    const port = readFileSync(join(DEPLOYMENTS_DIR, "ports/messaging-rail.ts"), "utf8");
    for (const handle of [
      "MessagingStore",
      "MessagingPolicyAdmission",
      "MessagingCapabilityAdmission",
      "MessagingBudgetAdmission",
      "MessagingSecretMediation",
      "MessagingExecutionLedger",
      "DatabasePort",
    ]) {
      expect(port.includes(handle), `the rail port must not carry a ${handle} handle`).toBe(false);
    }
    // Payloads cross as artifact references + bounded previews only.
    expect(port.includes("payloadRef")).toBe(true);
    expect(port.includes("payloadPreview")).toBe(true);
    expect(/Buffer|Uint8Array|Blob|base64/.test(port)).toBe(false);
    // Every side-effecting request carries the stable idempotency key.
    for (const shape of [
      "MessagingRailConversationRequest",
      "MessagingRailSendRequest",
      "MessagingRailEscalationRequest",
    ]) {
      const body = new RegExp(`export interface ${shape} \\{([\\s\\S]*?)\\n\\}`).exec(port)?.[1] ?? "";
      expect(body, `${shape} must exist`).not.toBe("");
      expect(body.includes("idempotencyKey"), `${shape} must carry idempotencyKey`).toBe(true);
    }
    expect(
      /closeConversation\(reference: \{([\s\S]*?)\n *\}\)/.exec(port)?.[1] ?? "",
    ).toContain("idempotencyKey");
  });

  test("MG3: the REQUIRED admission seams exist with the frozen method vocabulary", () => {
    const admission = readFileSync(join(DEPLOYMENTS_DIR, "ports/messaging-admission.ts"), "utf8");
    expect(admission.includes("admit(request: MessagingPolicyAdmissionRequest)")).toBe(true);
    expect(admission.includes("resolve(")).toBe(true);
    expect(admission.includes("reserve(command: MessagingBudgetReserveCommand)")).toBe(true);
    expect(admission.includes("settle(")).toBe(true);
    expect(admission.includes("release(")).toBe(true);
    expect(admission.includes("mediate(request: MessagingSecretMediationRequest)")).toBe(true);
  });

  test("MG4: the messaging conversation service deps are pinned (no extra authority seams)", () => {
    const service = readFileSync(
      join(DEPLOYMENTS_DIR, "application/messaging-conversation-service.ts"),
      "utf8",
    );
    const depsMatch = /export interface MessagingConversationServiceDeps \{([\s\S]*?)\n\}/.exec(
      service,
    );
    expect(depsMatch).not.toBeNull();
    const depNames = [...(depsMatch?.[1] ?? "").matchAll(/readonly (\w+):/g)]
      .map((m) => m[1] ?? "")
      .sort();
    expect(depNames).toEqual([
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
      "responder",
      "router",
      "secrets",
      "store",
    ]);
  });

  test("MG5: the migration claim (0020, the collision rule, physical guards)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0020_messaging_conversations.sql"),
      "utf8",
    );
    expect(migration.includes("deployments.messaging_conversations")).toBe(true);
    expect(migration.includes("deployments.messaging_messages")).toBe(true);
    expect(migration.includes("deployments.messaging_deliveries")).toBe(true);
    expect(migration.includes("deployments.messaging_escalations")).toBe(true);
    expect(migration.includes("deployments.messaging_operations")).toBe(true);
    for (const guard of [
      "msg_conversations_core_guard",
      "msg_conversations_lifecycle_guard",
      "msg_conversations_no_delete_guard",
      "msg_messages_append_only_guard",
      "msg_messages_attachments_refs_guard",
      "msg_deliveries_correlated_guard",
      "msg_deliveries_append_only_guard",
      "msg_escalations_immutable_guard",
      "msg_ops_core_guard",
      "msg_ops_lifecycle_guard",
      "msg_ops_no_delete_guard",
      "msg_conversations_key_unique",
      "msg_conversations_channel_unique",
      "msg_messages_key_unique",
      "msg_deliveries_key_unique",
      "msg_escalations_key_unique",
      "msg_ops_key_unique",
    ]) {
      expect(migration.includes(guard), `guard ${guard} must exist`).toBe(true);
    }
    // The parallel-wave collision discipline is documented in the file
    // (comment line breaks are respected — each claim phrase pinned).
    expect(migration.includes("0015 is BURNED")).toBe(true);
    expect(migration.includes("sibling WORK-021")).toBe(true);
    expect(migration.includes("claims 0019")).toBe(true);
    expect(migration.includes("WORK-025 claims 0020")).toBe(true);
    expect(migration.includes("0020 (THIS migration)")).toBe(true);
  });

  test("MG6: no messaging vendor identifier anywhere in the deployments tree", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (PROVIDER_IDENTIFIER.test(text)) {
        violations.push(`${relative}: provider identifier`);
      }
      if (
        /["'](twilio|vonage|slack|whatsapp|telegram|messenger|intercom|zendesk|sunshine|gupshup|infobip|messagebird|sendbird|lane|chatfuel)["']/i.test(
          text,
        )
      ) {
        violations.push(`${relative}: vendor rail slug`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("MG7: the messaging domain and ports stay pure (no platform, no SDK)", () => {
    const violations: string[] = [];
    for (const file of FILES.filter((f) => /\/(domain|ports)\//.test(f))) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (/from ["'](\.\.\/)+\.\.\/(\.\.\/)?platform\//.test(text)) {
        violations.push(`${relative}: platform import`);
      }
      if (/from ["'](@[a-z]|pg|fastify)["']/.test(text)) {
        violations.push(`${relative}: external package import`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("MG8: the ledger adapter rides ONLY executions-owned step-event vocabulary", () => {
    const adapter = readFileSync(
      join(DEPLOYMENTS_DIR, "adapters/messaging-execution-ledger.ts"),
      "utf8",
    );
    expect(adapter.includes('"agent-session-started"')).toBe(true);
    expect(adapter.includes('"agent-action-recorded"')).toBe(true);
    expect(adapter.includes('"agent-session-completed"')).toBe(true);
    // No direct SQL anywhere in the adapter (the executions public seam only).
    expect(/INSERT|UPDATE |DELETE FROM/i.test(adapter)).toBe(false);
    expect(adapter.includes("recordStepEvent")).toBe(true);
    expect(adapter.includes("createExecution")).toBe(true);
    // The human-escalation wait moves execution status ONLY through the
    // public transition-command surface (never a private write).
    expect(adapter.includes('"wait-human"')).toBe(true);
    expect(adapter.includes('"resume"')).toBe(true);
  });

  test("MG9: no rule violations over the messaging tree (the shared engine)", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const violations = scanDependencyRules(files, { allowedPackages: ["fastify"] });
    const messagingViolations = violations.filter((v) =>
      v.path.startsWith("src/modules/deployments"),
    );
    expect(messagingViolations.map((v) => `${v.rule} @ ${v.path}`)).toEqual([]);
  });

  test("MG10: the deployments public barrel exports the messaging surface (the only import seam)", () => {
    const publicBarrel = readFileSync(join(DEPLOYMENTS_DIR, "public.ts"), "utf8");
    for (const exported of [
      "createMessagingConversationService",
      "InMemoryMessagingStore",
      "SqlMessagingStore",
      "createInProcessMessagingRail",
      "createPolicyMessagingAdmission",
      "createCapabilityMessagingAdmission",
      "createBudgetMessagingAdmission",
      "createConnectionsMessagingSecretMediation",
      "createMessagingExecutionLedgerAdapter",
      "createPlannerMessagingSubtaskRouter",
      "createMessagingModalityAdapter",
      "messagingOperationKey",
      "messagingRailSendKey",
    ]) {
      expect(publicBarrel.includes(exported), `${exported} must cross the barrel`).toBe(true);
    }
  });
});
