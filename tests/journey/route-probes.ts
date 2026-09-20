/**
 * PPR-003 — the public-route honest-boundary probe table.
 *
 * The production/deployment journey's route-table sweep: EVERY public
 * route of the deployed plane must answer with its honest boundary
 * semantics — the exact grammar of deploy/public-smoke.ts (DEP-003
 * AC1), re-declared here because the deploy tool keeps its table
 * module-private (this file owns NO new expectation: the table is
 * pinned against docs/developer/machine/openapi.json — the machine
 * artifact of the public route table — by the contract unit test, so
 * drift between the two tables is a test failure).
 *
 *  - auth-boundary: the executions/agents/economic-actions/codebase-
 *    analysis surfaces reach the authenticate seam and answer the
 *    honest 401 AUTHENTICATION_FAILED (well-formed probes — no
 *    capability is ever fabricated);
 *  - capability-unbound: the credentials + sandbox-governance seams
 *    answer the honest 422 CAPABILITY_UNAVAILABLE of the unbound
 *    composition;
 *  - public-artifact: the one unauthenticated 200 — the versioned
 *    sandbox data-policy document with its digest.
 */

export type RouteExpectation = "auth-boundary" | "capability-unbound" | "public-artifact";

export interface RouteProbe {
  readonly route: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly expect: RouteExpectation;
}

/** A synthetic scope for the probes (no capability is ever fabricated). */
const PROBE_APPLICATION = "00000000-0000-0000-0000-000000000000";
const PROBE_ID = "00000000-0000-0000-0000-000000000000";
const PROBE_REPOSITORY = "zeck-journey-probe/repo";
const PROBE_REVISION = "0000000000000000000000000000000000000000";

/** The full public-route probe table (26 routes — public-smoke parity). */
export const ROUTE_PROBES: readonly RouteProbe[] = Object.freeze([
  // --- executions (API-001): reach the authenticate seam ----------------
  {
    route: "POST /executions",
    method: "POST",
    path: "/executions",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      task: { kind: "journey-probe" },
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id",
    method: "GET",
    path: `/executions/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "POST /executions/:id/cancel",
    method: "POST",
    path: `/executions/${PROBE_ID}/cancel`,
    body: "{}",
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/events",
    method: "GET",
    path: `/executions/${PROBE_ID}/events`,
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/verification",
    method: "GET",
    path: `/executions/${PROBE_ID}/verification`,
    expect: "auth-boundary",
  },
  {
    route: "GET /executions/:id/results",
    method: "GET",
    path: `/executions/${PROBE_ID}/results`,
    expect: "auth-boundary",
  },
  // --- agents: reach the authenticate seam --------------------------------
  { route: "GET /agents", method: "GET", path: "/agents", expect: "auth-boundary" },
  { route: "GET /agents/:id", method: "GET", path: `/agents/${PROBE_ID}`, expect: "auth-boundary" },
  {
    route: "GET /agents/:id/versions",
    method: "GET",
    path: `/agents/${PROBE_ID}/versions`,
    expect: "auth-boundary",
  },
  {
    route: "GET /agents/:id/status",
    method: "GET",
    path: `/agents/${PROBE_ID}/status`,
    expect: "auth-boundary",
  },
  // --- economic-actions: well-formed closed-contract body ------------------
  {
    route: "POST /economic-actions",
    method: "POST",
    path: "/economic-actions",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      executionId: PROBE_ID,
      purpose: "journey-probe",
      recipient: { kind: "external-account", id: "journey-probe" },
      amount: { kind: "exact", microUsd: "1" },
      currency: "USD",
      expiresAt: "2030-01-01T00:00:00.000Z",
      requiredCapabilities: [],
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id/events",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}/events`,
    expect: "auth-boundary",
  },
  {
    route: "GET /economic-actions/:id/outcome",
    method: "GET",
    path: `/economic-actions/${PROBE_ID}/outcome`,
    expect: "auth-boundary",
  },
  // --- codebase-analysis: a valid selection reaches the authenticate seam --
  {
    route: "POST /codebase-analysis",
    method: "POST",
    path: "/codebase-analysis",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      source: { repository: PROBE_REPOSITORY, revision: PROBE_REVISION },
      subgraph: {
        nodes: [
          {
            nodeId: "journey-probe-node",
            kind: "function",
            label: "journey probe node",
            provenance: {
              repository: PROBE_REPOSITORY,
              revision: PROBE_REVISION,
              file: "src/journey-probe.ts",
            },
            observation: { executionCount: 1, evidenceRefs: ["journey-probe"] },
          },
        ],
        edges: [],
      },
    }),
    expect: "auth-boundary",
  },
  {
    route: "GET /codebase-analysis/:id",
    method: "GET",
    path: `/codebase-analysis/${PROBE_ID}`,
    expect: "auth-boundary",
  },
  {
    route: "POST /codebase-analysis/:id/ratings",
    method: "POST",
    path: `/codebase-analysis/${PROBE_ID}/ratings`,
    body: JSON.stringify({ applicationId: PROBE_APPLICATION }),
    expect: "auth-boundary",
  },
  {
    route: "POST /codebase-analysis/:id/findings/:findingId/transition",
    method: "POST",
    path: `/codebase-analysis/${PROBE_ID}/findings/finding-probe/transition`,
    body: JSON.stringify({ applicationId: PROBE_APPLICATION }),
    expect: "auth-boundary",
  },
  // --- credentials (DEP-011 seams): the honest composition fact ------------
  {
    route: "POST /credentials",
    method: "POST",
    path: "/credentials",
    body: JSON.stringify({
      applicationId: PROBE_APPLICATION,
      label: "journey-probe",
      role: "operator",
    }),
    expect: "capability-unbound",
  },
  { route: "GET /credentials", method: "GET", path: "/credentials", expect: "capability-unbound" },
  {
    route: "POST /credentials/:credentialId/rotate",
    method: "POST",
    path: `/credentials/${PROBE_ID}/rotate`,
    body: "{}",
    expect: "capability-unbound",
  },
  {
    route: "POST /credentials/:credentialId/revoke",
    method: "POST",
    path: `/credentials/${PROBE_ID}/revoke`,
    body: "{}",
    expect: "capability-unbound",
  },
  // --- sandbox governance (DEP-014 seams): the honest composition fact -----
  {
    route: "GET /sandbox/quotas",
    method: "GET",
    path: "/sandbox/quotas",
    expect: "capability-unbound",
  },
  {
    route: "GET /sandbox/identities/:identityId",
    method: "GET",
    path: `/sandbox/identities/${PROBE_ID}`,
    expect: "capability-unbound",
  },
  {
    route: "POST /sandbox/identities/:identityId/reset",
    method: "POST",
    path: `/sandbox/identities/${PROBE_ID}/reset`,
    body: "{}",
    expect: "capability-unbound",
  },
  // --- the public policy artifact: the one unauthenticated 200 ------------
  {
    route: "GET /sandbox/data-policy",
    method: "GET",
    path: "/sandbox/data-policy",
    expect: "public-artifact",
  },
] as const);

/** The honest expectation of a probe's observed answer (the boundary grammar). */
export function routeProbeProblem(probe: RouteProbe, status: number, code: string): string | null {
  if (probe.expect === "auth-boundary") {
    if (status !== 401 || code !== "AUTHENTICATION_FAILED") {
      return `${probe.route}: answered ${status} ${code || "(no code)"} (expected the honest 401 AUTHENTICATION_FAILED — the auth boundary must be enforced with no fabricated capability)`;
    }
    return null;
  }
  if (probe.expect === "capability-unbound") {
    if (status !== 422 || code !== "CAPABILITY_UNAVAILABLE") {
      return `${probe.route}: answered ${status} ${code || "(no code)"} (expected the honest 422 CAPABILITY_UNAVAILABLE of the unbound composition — never a fabricated fact)`;
    }
    return null;
  }
  if (status !== 200) {
    return `${probe.route}: answered ${status} (expected 200 with the versioned policy artifact — the public governed document)`;
  }
  return null;
}
