/**
 * Unit — agents module domain validation (WORK-011).
 *
 * Fail-closed validation of every domain shape: agent registration, the
 * immutable agent definition (closed shape + raw-secret rejection — the
 * M6 boundary), permission intersection semantics (M9), session
 * lifecycle vocabulary, credential-grant usability (M8), approval
 * dispatch authorization (M13/M14), and workspace scope checks (M3/M4).
 */

import { describe, expect, test } from "vitest";
import type { AgentDefinition } from "../../../src/modules/agents/public";
import {
  AGENT_LIFECYCLE_STATUSES,
  actionRequiresApproval,
  agentMayStartSessions,
  approvalAuthorizesDispatch,
  autonomyEngagesApprovalGate,
  canTransitionSession,
  checkWorkspaceScope,
  containsRawSecretValue,
  effectivePermissionsOf,
  grantIsUsable,
  isTerminalAgentStatus,
  validateAgentDefinition,
  validateAgentRegistration,
} from "../../../src/modules/agents/public";

const VALID_DEFINITION: AgentDefinition = {
  instructions: "Summarize the provided artifact and propose next steps.",
  requestedPermissions: {
    tools: ["search-web", "calculator"],
    secretRefs: ["conn-customer-api"],
  },
  approvalRequiredActions: ["external-write", "publish"],
  isolation: "container",
  maxAutonomy: "gated",
  maxSessionDurationMs: 600000,
};

describe("agent registration validation", () => {
  test("accepts a well-formed registration", () => {
    expect(
      validateAgentRegistration({
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        slug: "support-agent",
        name: "Support Agent",
      }),
    ).toEqual({ valid: true });
  });

  test("rejects malformed slugs, names, and scope ids (fail closed)", () => {
    const applicationId = "00000000-0000-7000-8000-0000000000b1";
    const tenantId = "00000000-0000-7000-8000-0000000000a1";
    expect(
      validateAgentRegistration({ applicationId, tenantId, slug: "Bad_Slug", name: "x" }).valid,
    ).toBe(false);
    expect(validateAgentRegistration({ applicationId, tenantId, slug: "ok", name: "" }).valid).toBe(
      false,
    );
    expect(
      validateAgentRegistration({ applicationId, tenantId: "nope", slug: "ok", name: "x" }).valid,
    ).toBe(false);
    expect(validateAgentRegistration(null).valid).toBe(false);
    expect(validateAgentRegistration("string").valid).toBe(false);
  });

  test("the agent lifecycle vocabulary is small, explicit and terminal-aware", () => {
    expect([...AGENT_LIFECYCLE_STATUSES]).toEqual([
      "registered",
      "validated",
      "available",
      "suspended",
      "retired",
    ]);
    expect(agentMayStartSessions("available")).toBe(true);
    expect(agentMayStartSessions("registered")).toBe(false);
    expect(agentMayStartSessions("suspended")).toBe(false);
    expect(isTerminalAgentStatus("retired")).toBe(true);
  });
});

describe("agent definition validation (the immutable version payload)", () => {
  test("accepts a well-formed definition", () => {
    expect(validateAgentDefinition(VALID_DEFINITION)).toEqual({ valid: true });
  });

  test("rejects unknown fields (closed shape — raw secrets are unrepresentable)", () => {
    const withExtra = { ...VALID_DEFINITION, apiKey: "sk-abcdefghij0123456789" } as unknown;
    const check = validateAgentDefinition(withExtra);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toContain("closed shape");
    }
  });

  test("rejects raw long-lived secret material embedded in instructions (M6)", () => {
    const secrets = [
      "use key sk-abcdefghij0123456789abcd",
      "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "api_key = AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
      "Bearer abcdefghijklmnopqrstuvwxyz123456",
      "-----BEGIN RSA PRIVATE KEY-----",
      "password: supersecretvalue12345",
    ];
    for (const secret of secrets) {
      const check = validateAgentDefinition({ ...VALID_DEFINITION, instructions: secret });
      expect(check.valid, `must reject ${secret.slice(0, 24)}…`).toBe(false);
    }
  });

  test("containsRawSecretValue detects vendor key shapes and benign text passes", () => {
    expect(containsRawSecretValue("sk-abcdefghij0123456789")).toBe(true);
    expect(containsRawSecretValue("ghp_abcdefghijklmnopqrstuvwxyz1234567890")).toBe(true);
    expect(containsRawSecretValue("Bearer abcdefghijklmnopqrstuvwxyz12")).toBe(true);
    expect(containsRawSecretValue("use the search tool for public data")).toBe(false);
    expect(containsRawSecretValue("conn-customer-api reference")).toBe(false);
  });

  test("rejects malformed permission requests and durations (fail closed)", () => {
    expect(
      validateAgentDefinition({
        ...VALID_DEFINITION,
        requestedPermissions: { tools: [], secretRefs: [] },
      }).valid,
    ).toBe(true);
    expect(
      validateAgentDefinition({
        ...VALID_DEFINITION,
        requestedPermissions: { tools: ["UPPER"], secretRefs: [] },
      }).valid,
    ).toBe(false);
    expect(
      validateAgentDefinition({
        ...VALID_DEFINITION,
        requestedPermissions: { tools: ["a"], secretRefs: ["a", "a"] },
      }).valid,
    ).toBe(false);
    expect(
      validateAgentDefinition({ ...VALID_DEFINITION, approvalRequiredActions: ["Bad Action"] })
        .valid,
    ).toBe(false);
    expect(validateAgentDefinition({ ...VALID_DEFINITION, maxSessionDurationMs: 0 }).valid).toBe(
      false,
    );
    expect(
      validateAgentDefinition({ ...VALID_DEFINITION, maxSessionDurationMs: 90_000_000 }).valid,
    ).toBe(false);
    expect(validateAgentDefinition({ ...VALID_DEFINITION, instructions: "" }).valid).toBe(false);
    expect(validateAgentDefinition(null).valid).toBe(false);
  });
});

describe("effective permissions (the policy intersection, M9)", () => {
  test("effective = requested ∩ approved — never the requested superset", () => {
    const effective = effectivePermissionsOf(
      { tools: ["a", "b", "c"], secretRefs: ["r1", "r2"], models: ["m1"] },
      { tools: ["b", "c", "z"], secretRefs: ["r2", "r9"], models: ["m1"] },
    );
    expect(effective).toEqual({ tools: ["b", "c"], secretRefs: ["r2"], models: ["m1"] });
  });

  test("an empty approval leaves nothing effective (no self-grant possible)", () => {
    const effective = effectivePermissionsOf(
      { tools: ["a"], secretRefs: ["r1"] },
      { tools: [], secretRefs: [] },
    );
    expect(effective).toEqual({ tools: [], secretRefs: [], models: [] });
  });
});

describe("credential grant usability (M8)", () => {
  test("only active, unexpired grants are usable", () => {
    const now = "2026-01-01T12:00:00.000Z";
    expect(grantIsUsable("active", null, now)).toBe(true);
    expect(grantIsUsable("active", "2026-01-02T00:00:00.000Z", now)).toBe(true);
    expect(grantIsUsable("revoked", null, now)).toBe(false);
    expect(grantIsUsable("expired", null, now)).toBe(false);
    expect(grantIsUsable("active", "2026-01-01T11:00:00.000Z", now)).toBe(false);
  });
});

describe("approval dispatch authorization (M13/M14)", () => {
  test("only approved, unexpired approvals authorize dispatch", () => {
    const now = "2026-01-01T12:00:00.000Z";
    expect(approvalAuthorizesDispatch({ status: "approved", expiresAt: null }, now)).toBe(true);
    expect(approvalAuthorizesDispatch({ status: "pending", expiresAt: null }, now)).toBe(false);
    expect(approvalAuthorizesDispatch({ status: "revoked", expiresAt: null }, now)).toBe(false);
    expect(approvalAuthorizesDispatch({ status: "denied", expiresAt: null }, now)).toBe(false);
    expect(
      approvalAuthorizesDispatch(
        { status: "approved", expiresAt: "2026-01-01T11:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });

  test("approval gates engage only for configured actions under gated autonomy", () => {
    const definition = { approvalRequiredActions: ["external-write"] };
    expect(actionRequiresApproval("external-write", definition)).toBe(true);
    expect(actionRequiresApproval("read-only", definition)).toBe(false);
    expect(autonomyEngagesApprovalGate("gated")).toBe(true);
    expect(autonomyEngagesApprovalGate("none")).toBe(true);
    expect(autonomyEngagesApprovalGate("sandboxed")).toBe(false);
    expect(autonomyEngagesApprovalGate("unconstrained")).toBe(false);
  });
});

describe("session lifecycle vocabulary", () => {
  test("the explicit session transition table (subordinate to Execution)", () => {
    expect(canTransitionSession("pending", "running")).toBe(true);
    expect(canTransitionSession("pending", "completed")).toBe(false);
    expect(canTransitionSession("running", "waiting-approval")).toBe(true);
    expect(canTransitionSession("waiting-approval", "running")).toBe(true);
    expect(canTransitionSession("waiting-approval", "failed")).toBe(true);
    expect(canTransitionSession("completed", "running")).toBe(false);
    expect(canTransitionSession("failed", "running")).toBe(false);
    expect(canTransitionSession("cancelled", "anything" as never)).toBe(false);
  });
});

describe("workspace scope checks (M3/M4)", () => {
  const workspace = {
    id: "00000000-0000-7000-8000-0000000000w1",
    applicationId: "00000000-0000-7000-8000-0000000000b1",
    tenantId: "00000000-0000-7000-8000-0000000000a1",
    executionId: "00000000-0000-7000-8000-0000000000x1",
    sessionId: "00000000-0000-7000-8000-0000000000s1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const expected = {
    applicationId: workspace.applicationId,
    tenantId: workspace.tenantId,
    executionId: workspace.executionId,
  };

  test("matching scope passes", () => {
    expect(checkWorkspaceScope(workspace, expected)).toBeNull();
  });

  test("tenant mismatch fails closed", () => {
    const error = checkWorkspaceScope(workspace, { ...expected, tenantId: "other" });
    expect(error?.code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("application mismatch fails closed", () => {
    const error = checkWorkspaceScope(workspace, { ...expected, applicationId: "other" });
    expect(error?.code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("execution mismatch fails closed", () => {
    const error = checkWorkspaceScope(workspace, { ...expected, executionId: "other" });
    expect(error?.code).toBe("TENANT_SCOPE_VIOLATION");
  });
});
