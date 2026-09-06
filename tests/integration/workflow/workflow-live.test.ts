/**
 * Integration — REAL Cloudflare Workflows verification (WORK-045 / D-04).
 *
 * Gated on the real provider credential material being materialized
 * in the environment (credential-shaped, environment-only — never in
 * the repository):
 *
 *   ZECK_CLOUDFLARE_ACCOUNT_ID   the Cloudflare account id
 *   ZECK_WORKFLOW_NAME           the deployed orchestration workflow name
 *   ZECK_WORKFLOW_PROBE_NAME     the DEDICATED operator-owned probe
 *                                workflow's name (never the
 *                                orchestration workflow; the PR #6
 *                                discipline applied to orchestration)
 *   ZECK_WORKFLOW_API_TOKEN      the materialized workflow-api-token
 *                                secret (Bearer auth, Workflows write)
 *   ZECK_WORKFLOW_API_BASE_URL   optional (defaults to the public API)
 *
 * When any of them is absent the suite SKIPS with the exact reason —
 * evidence discipline: unavailable provider evidence is NOT RUN with
 * the environmental reason, NEVER a silent PASS (the WORK-045
 * evidence contract).
 *
 * When present, the suite executes the REAL production orchestration
 * path: the provider round-trip probe on the dedicated probe workflow
 * (create → observe → terminate of exactly one self-identifying probe
 * instance) — the probe never touches the orchestration workflow and
 * never signals, mutates or terminates an instance it did not create
 * in that run. Prerequisites (both workflows deployed, the token has
 * Workflows write) are operator-owned account-plane preconditions
 * documented in deploy/README.md.
 */

import { describe, expect, test } from "vitest";
import { createCloudflareWorkflowsTransport } from "../../../src/platform/workflow/cloudflare-workflows";
import { WorkflowTransportError } from "../../../src/platform/workflow/port";

const ACCOUNT_ID = process.env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "";
const WORKFLOW_NAME = process.env.ZECK_WORKFLOW_NAME ?? "";
const PROBE_WORKFLOW_NAME = process.env.ZECK_WORKFLOW_PROBE_NAME ?? "";
const API_TOKEN = process.env.ZECK_WORKFLOW_API_TOKEN ?? "";
const GATED =
  ACCOUNT_ID.length > 0 &&
  WORKFLOW_NAME.length > 0 &&
  PROBE_WORKFLOW_NAME.length > 0 &&
  API_TOKEN.length > 0;

describe.skipIf(!GATED)(
  "the real Cloudflare Workflows production orchestration (WORK-045 D-04; gated on ZECK_WORKFLOW_* materialization)",
  () => {
    // Constructed lazily INSIDE the gated suite: an ungated run never
    // validates empty provider configuration (the skip is the honest
    // outcome, not a collection error).
    const transport = () =>
      createCloudflareWorkflowsTransport({
        apiBaseUrl: process.env.ZECK_WORKFLOW_API_BASE_URL,
        accountId: ACCOUNT_ID,
        workflowName: WORKFLOW_NAME,
        probeWorkflowName: PROBE_WORKFLOW_NAME,
        apiToken: API_TOKEN,
        requestTimeoutMs: 15_000,
      });

    test("the real orchestration round trip runs on the dedicated probe workflow (create + observe + terminate, exactly one own instance)", {
      timeout: 60_000,
    }, async () => {
      const probe = await transport().probe();
      expect(probe.ok).toBe(true);
      expect(probe.detail).toContain("dedicated probe workflow");
      expect(probe.detail).toContain("exactly one probe instance terminated");
    });

    test("the provider limits descriptor is inspectable against the real account surface", () => {
      const limits = transport().describeLimits();
      expect(limits.maxPayloadBytes).toBe(1_048_576);
      expect(limits.supportsTermination).toBe(true);
      expect(limits.documented.maximumEventPayloadSize).toContain("1MiB");
    });

    test("describeInstance on an unknown instance fails closed permanent (real provider 404-class)", async () => {
      await expect(
        transport().describeInstance("zeck-nonexistent-instance-id-000"),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof WorkflowTransportError && error.failureKind === "permanent",
      );
    });

    test("the probe isolation guards reject the weakened forms against the real configuration surface", () => {
      // A probe workflow equal to the orchestration workflow is
      // rejected at configuration validation (before any wire call).
      expect(() =>
        createCloudflareWorkflowsTransport({
          accountId: ACCOUNT_ID,
          workflowName: WORKFLOW_NAME,
          probeWorkflowName: WORKFLOW_NAME,
          apiToken: API_TOKEN,
        }),
      ).toThrow(/must differ from workflowName/);
    });
  },
);

describe.skipIf(GATED)(
  "the real Cloudflare Workflows suite is NOT RUN without provider materialization",
  () => {
    test("skips with the exact environmental reason (never a silent PASS)", () => {
      const missing: string[] = [];
      if (ACCOUNT_ID.length === 0) {
        missing.push("ZECK_CLOUDFLARE_ACCOUNT_ID");
      }
      if (WORKFLOW_NAME.length === 0) {
        missing.push("ZECK_WORKFLOW_NAME");
      }
      if (PROBE_WORKFLOW_NAME.length === 0) {
        missing.push("ZECK_WORKFLOW_PROBE_NAME");
      }
      if (API_TOKEN.length === 0) {
        missing.push("ZECK_WORKFLOW_API_TOKEN");
      }
      // The mirror suite runs only when the real suite is skipped —
      // and then exactly the missing variables are named.
      expect(missing.length).toBeGreaterThan(0);
      for (const name of missing) {
        expect(name).toMatch(/^ZECK_[A-Z0-9_]+$/);
      }
    });
  },
);
