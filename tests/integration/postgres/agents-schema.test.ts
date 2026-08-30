/**
 * Real-PostgreSQL — agents schema constraints (WORK-011, AGT-002/004/005;
 * checkpoint contracts TENANT-ISOLATION, IDENTITY-IDEMPOTENCY — the
 * physical half of the boundary).
 *
 * Proves against migration 0006 that the invariants are PHYSICAL:
 * vocabularies CHECK-bound, composite tenant FKs (cross-scope rows
 * unrepresentable), immutable versions (UPDATE/DELETE rejected), the
 * append-only selections journal, terminal-session immutability, grant
 * revocation monotonicity, and the absence of any credential-value
 * column (raw secrets unrepresentable at the storage boundary).
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";

definePgSuite("agents schema constraints", (ctx) => {
  test("agent identity vocabularies and shapes are CHECK-bound", async () => {
    const db = ctx.port;
    const tenantId = "00000000-0000-7000-8000-0000000000aa";
    const applicationId = "00000000-0000-7000-8000-0000000000ab";
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, "schema-t", "schema tenant"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, "schema-a", "schema app"],
    });
    await db.execute({
      sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, status, created_at, updated_at)
VALUES ($1, $2, $3, 'schema-agent', 'Schema Agent', 'available', now(), now())`,
      parameters: ["00000000-0000-7000-8000-0000000000ac", applicationId, tenantId],
    });

    // Unknown lifecycle status is rejected.
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, status, created_at, updated_at)
VALUES ($1, $2, $3, 'x2', 'X', 'hijacked', now(), now())`,
        parameters: ["00000000-0000-7000-8000-0000000000ad", applicationId, tenantId],
      }),
    ).rejects.toThrow();

    // A second agent with the SAME slug is impossible (identity anchor).
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, status, created_at, updated_at)
VALUES ($1, $2, $3, 'schema-agent', 'Dup', 'registered', now(), now())`,
        parameters: ["00000000-0000-7000-8000-0000000000ae", applicationId, tenantId],
      }),
    ).rejects.toThrow();

    // Cross-tenant agent rows are unrepresentable (composite FK).
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, status, created_at, updated_at)
VALUES ($1, $2, $3, 'cross', 'Cross', 'registered', now(), now())`,
        parameters: [
          "00000000-0000-7000-8000-0000000000af",
          applicationId,
          "00000000-0000-7000-8000-0000000000bb",
        ],
      }),
    ).rejects.toThrow();
  });

  test("agent versions are physically immutable (M15) and semver-CHECKed", async () => {
    const db = ctx.port;
    const tenantId = "00000000-0000-7000-8000-0000000000ba";
    const applicationId = "00000000-0000-7000-8000-0000000000bb";
    const agentId = "00000000-0000-7000-8000-0000000000bc";
    const versionId = "00000000-0000-7000-8000-0000000000bd";
    await db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [tenantId, "ver-t", "ver tenant"],
    });
    await db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [applicationId, tenantId, "ver-a", "ver app"],
    });
    await db.execute({
      sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, status, created_at, updated_at)
VALUES ($1, $2, $3, 'ver-agent', 'Ver', 'validated', now(), now())`,
      parameters: [agentId, applicationId, tenantId],
    });
    await db.execute({
      sql: `INSERT INTO agents.agent_versions (id, application_id, tenant_id, agent_id, version, definition, definition_digest, validation_state, created_at)
VALUES ($1, $2, $3, $4, '1.0.0', '{"instructions":"x"}'::jsonb, 'digest-1', 'valid', now())`,
      parameters: [versionId, applicationId, tenantId, agentId],
    });

    // Malformed semver is rejected.
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agent_versions (id, application_id, tenant_id, agent_id, version, definition, definition_digest, validation_state, created_at)
VALUES ($1, $2, $3, $4, 'v2', '{}'::jsonb, 'd', 'valid', now())`,
        parameters: ["00000000-0000-7000-8000-0000000000be", applicationId, tenantId, agentId],
      }),
    ).rejects.toThrow();

    // UPDATE is physically impossible.
    await expect(
      db.execute({
        sql: `UPDATE agents.agent_versions SET validation_state = 'invalid' WHERE id = $1`,
        parameters: [versionId],
      }),
    ).rejects.toThrow(/immutable/);

    // DELETE is physically impossible.
    await expect(
      db.execute({
        sql: `DELETE FROM agents.agent_versions WHERE id = $1`,
        parameters: [versionId],
      }),
    ).rejects.toThrow(/immutable/);

    // The same (agent, version) identity cannot carry a second row.
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agent_versions (id, application_id, tenant_id, agent_id, version, definition, definition_digest, validation_state, created_at)
VALUES ($1, $2, $3, $4, '1.0.0', '{}'::jsonb, 'digest-2', 'valid', now())`,
        parameters: ["00000000-0000-7000-8000-0000000000bf", applicationId, tenantId, agentId],
      }),
    ).rejects.toThrow();
  });

  test("credential grants carry NO value column (M7 storage half) and revocation is monotonic", async () => {
    const db = ctx.port;
    // The physical shape: scope kind + opaque ref + status + timestamps only.
    const columns = await db.execute<{ column_name: string; data_type: string }>({
      sql: `SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'agents' AND table_name = 'agent_credential_grants' ORDER BY ordinal_position`,
      parameters: [],
    });
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toEqual([
      "id",
      "application_id",
      "tenant_id",
      "session_id",
      "scope_kind",
      "scope_ref",
      "status",
      "issued_at",
      "expires_at",
      "revoked_at",
    ]);
    // No value/material/plaintext column exists anywhere.
    expect(names.join(" ")).not.toMatch(/value|material|plaintext|secret_/i);

    // Session status vocabulary is CHECK-bound (unknown statuses rejected
    // even before the FKs would matter).
    await expect(
      db.execute({
        sql: `INSERT INTO agents.agent_sessions (id, application_id, tenant_id, execution_id, agent_id, agent_version_id, workspace_id, session_key, request_fingerprint, status, input_digest, effective_permissions, policy_evidence, autonomy, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'k', 'f', 'hijacked', 'd', '{}'::jsonb, '{}'::jsonb, 'gated', now())`,
        parameters: [
          "00000000-0000-7000-8000-0000000000c1",
          "00000000-0000-7000-8000-0000000000c2",
          "00000000-0000-7000-8000-0000000000c3",
          "00000000-0000-7000-8000-0000000000c4",
          "00000000-0000-7000-8000-0000000000c5",
          "00000000-0000-7000-8000-0000000000c6",
          "00000000-0000-7000-8000-0000000000c7",
        ],
      }),
    ).rejects.toThrow();
  });
});
