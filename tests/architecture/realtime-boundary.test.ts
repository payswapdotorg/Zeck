/**
 * Architecture: the realtime voice-session boundary (WORK-024,
 * MOD-005/006/007; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE).
 *
 * Mechanically proves over the REAL `src/modules/deployments/` tree and
 * migration 0018:
 *
 *  - RT1 the realtime rail port carries NO authority surface (MOD-005:
 *    replaceable upstream infrastructure): its METHOD set is exactly the
 *    transport duo-plus {openSession, deliverTurn, transferCall,
 *    closeSession}; no admission/authorize/budget/execute/invoke/
 *    dispatch/transition vocabulary, no authority type handles;
 *  - RT2 the rail port's shapes are coordinates-only: no store, policy,
 *    capability, budget or execution handles cross the seam; raw media
 *    never crosses (artifact references + bounded previews only);
 *  - RT3 the REQUIRED admission seams exist with the frozen method
 *    vocabulary (admit / resolve / reserve+settle+release / mediate) —
 *    the session service cannot be constructed without them;
 *  - RT4 the realtime session service deps are pinned: exactly {store,
 *    deployments, rail, policy, capabilities, budget, secrets, router,
 *    responder, ledger, railConnectionRef, digest, generateId, now} —
 *    no additional authority handles are reachable;
 *  - RT5 migration 0018 is the realtime migration with the physical
 *    guards (identity-core immutability, pinned plan version, the
 *    lifecycle/epoch machine, no delete, append-only journal, inbound
 *    idempotency UNIQUE, the stale-callback freshness trigger) and the
 *    parallel-wave collision-rule discipline (0015 burned, sibling
 *    0017, WORK-024 claims 0018);
 *  - RT6 provider neutrality: no realtime vendor identifier anywhere in
 *    the deployments tree (the provider-neutrality scanners extended to
 *    the realtime vocabulary);
 *  - RT7 the realtime domain and ports stay pure: no `src/platform/**`
 *    import in domain/ or ports/, no provider SDK imports;
 *  - RT8 the ledger adapter produces ONLY executions-owned step-event
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
const REALTIME_FILES = FILES.filter((file) =>
  /realtime|in-process-realtime|planner-subtask/.test(file),
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

describe("architecture: the realtime voice-session boundary (WORK-024)", () => {
  test("the realtime files are present and scanned", () => {
    expect(REALTIME_FILES.length).toBeGreaterThanOrEqual(10);
  });

  test("RT1: the rail port's METHOD set is exactly the transport surface", () => {
    const port = readFileSync(join(DEPLOYMENTS_DIR, "ports/realtime-rail.ts"), "utf8");
    for (const forbidden of AUTHORITY_VOCABULARY) {
      expect(port.includes(forbidden), `the rail port must not carry "${forbidden}"`).toBe(false);
    }
    const interfaceBody = /export interface RealtimeRail \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    const methodNames = [...interfaceBody.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)]
      .map((m) => m[1] ?? "")
      .filter((name) => name !== "descriptor");
    expect([...new Set(methodNames)].sort()).toEqual([
      "closeSession",
      "deliverTurn",
      "openSession",
      "transferCall",
    ]);
    // The descriptor is the transport-class declaration only.
    expect(port.includes('transportClass: "realtime"')).toBe(true);
    // The callback frame carries coordinates + bounded payload only.
    const callback = /export interface RealtimeRailCallback \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    expect(callback.includes("channelSessionRef")).toBe(true);
    expect(callback.includes("channelEpoch")).toBe(true);
    expect(callback.includes("eventKey")).toBe(true);
  });

  test("RT2: the rail port's shapes are coordinates-only (no authority handles, no raw media)", () => {
    const port = readFileSync(join(DEPLOYMENTS_DIR, "ports/realtime-rail.ts"), "utf8");
    for (const handle of [
      "RealtimeStore",
      "RealtimePolicyAdmission",
      "RealtimeCapabilityAdmission",
      "RealtimeBudgetAdmission",
      "RealtimeSecretMediation",
      "RealtimeExecutionLedger",
      "DatabasePort",
    ]) {
      expect(port.includes(handle), `the rail port must not carry a ${handle} handle`).toBe(false);
    }
    // Media crosses as artifact references + bounded previews only.
    expect(port.includes("responseRef")).toBe(true);
    expect(port.includes("payloadRef")).toBe(true);
    expect(/Buffer|Uint8Array|Blob|base64 audio/.test(port)).toBe(false);
  });

  test("RT3: the REQUIRED admission seams exist with the frozen method vocabulary", () => {
    const admission = readFileSync(
      join(DEPLOYMENTS_DIR, "ports/realtime-admission.ts"),
      "utf8",
    );
    expect(admission.includes("admit(request: RealtimePolicyAdmissionRequest)")).toBe(true);
    expect(admission.includes("resolve(")).toBe(true);
    expect(admission.includes("reserve(command: RealtimeBudgetReserveCommand)")).toBe(true);
    expect(admission.includes("settle(")).toBe(true);
    expect(admission.includes("release(")).toBe(true);
    expect(admission.includes("mediate(request: RealtimeSecretMediationRequest)")).toBe(true);
  });

  test("RT4: the realtime session service deps are pinned (no extra authority seams)", () => {
    const service = readFileSync(
      join(DEPLOYMENTS_DIR, "application/realtime-session-service.ts"),
      "utf8",
    );
    const depsMatch = /export interface RealtimeSessionServiceDeps \{([\s\S]*?)\n\}/.exec(service);
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

  test("RT5: the migration claim (0018, the collision rule, physical guards)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0018_realtime_sessions.sql"),
      "utf8",
    );
    expect(migration.includes("deployments.realtime_sessions")).toBe(true);
    expect(migration.includes("deployments.realtime_events")).toBe(true);
    for (const guard of [
      "rt_sessions_core_guard",
      "rt_sessions_lifecycle_guard",
      "rt_sessions_no_delete_guard",
      "rt_events_channel_fresh_guard",
      "rt_events_append_only_guard",
      "rt_sessions_key_unique",
      "rt_sessions_channel_unique",
      "rt_events_key_unique",
    ]) {
      expect(migration.includes(guard), `guard ${guard} must exist`).toBe(true);
    }
    // The parallel-wave collision discipline is documented in the file
    // (comment line breaks are respected — each claim phrase pinned).
    expect(migration.includes("0015 is BURNED")).toBe(true);
    expect(migration.includes("sibling WORK-020")).toBe(true);
    expect(migration.includes("claims 0017")).toBe(true);
    expect(migration.includes("WORK-024 claims")).toBe(true);
    expect(migration.includes("0018 (THIS migration)")).toBe(true);
  });

  test("RT6: no realtime vendor identifier anywhere in the deployments tree", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (PROVIDER_IDENTIFIER.test(text)) {
        violations.push(`${relative}: provider identifier`);
      }
      if (/["'](twilio|vonage|livekit|daily|100ms|agora|slack|whatsapp|telegram)["']/i.test(text)) {
        violations.push(`${relative}: vendor rail slug`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("RT7: the realtime domain and ports stay pure (no platform, no SDK)", () => {
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

  test("RT8: the ledger adapter rides ONLY executions-owned step-event vocabulary", () => {
    const adapter = readFileSync(
      join(DEPLOYMENTS_DIR, "adapters/realtime-execution-ledger.ts"),
      "utf8",
    );
    expect(adapter.includes('"agent-session-started"')).toBe(true);
    expect(adapter.includes('"agent-action-recorded"')).toBe(true);
    expect(adapter.includes('"agent-session-completed"')).toBe(true);
    // No direct SQL anywhere in the adapter (the executions public seam only).
    expect(/INSERT|UPDATE |DELETE FROM/i.test(adapter)).toBe(false);
    // No executions table write target from any deployments adapter is
    // covered by D9; pin the ledger adapter's seam here.
    expect(adapter.includes("recordStepEvent")).toBe(true);
    expect(adapter.includes("createExecution")).toBe(true);
  });

  test("RT9: no rule violations over the realtime tree (the shared engine)", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const violations = scanDependencyRules(files, { allowedPackages: ["fastify"] });
    const realtimeViolations = violations.filter((v) =>
      v.path.startsWith("src/modules/deployments"),
    );
    expect(realtimeViolations.map((v) => `${v.rule} @ ${v.path}`)).toEqual([]);
  });
});
