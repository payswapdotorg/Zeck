/**
 * Zeck sandbox governance console module (DEP-014 — the budgets/quotas/
 * expiration/reset and synthetic-data-policy projection over the public
 * sandbox governance routes).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY (DEP-014): this module holds NO
 * console-local quota, identity or policy state. Every fact it renders is
 * read live from the public API routes the platform serves:
 *
 *   - the quota state       `GET /sandbox/quotas`
 *   - the identity state    `GET /sandbox/identities/:id`
 *   - the reset operation   `POST /sandbox/identities/:id/reset`
 *   - the policy artifact   `GET /sandbox/data-policy` (served VERBATIM —
 *                           the versioned platform document; the console
 *                           renders THIS, never a local copy)
 *
 * The transport is module-local over the public routes (the credentials.ts
 * pattern): Bearer + application scope; the reset POST carries the
 * Idempotency-Key. An unwired deployment answers the honest 422 and the
 * console renders the honest unavailable state naming the missing
 * composition — never a fabricated fact.
 */

/** One quota record as the public route serves it. */
export interface SandboxQuotaFact {
  readonly id: string;
  readonly applicationId: string;
  readonly dimension: string;
  readonly limit: string;
  readonly consumed: string;
  readonly window: string;
  readonly status: string;
  readonly identityId: string | null;
  readonly updatedAt: string;
}

/** The quota-list response shape (telemetry boundary included). */
export interface SandboxQuotaListFact {
  readonly quotas: readonly SandboxQuotaFact[];
  readonly telemetry: { readonly realtime: boolean };
}

/** One sandbox identity as the public route serves it. */
export interface SandboxIdentityFact {
  readonly id: string;
  readonly applicationId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly supersededBy: string | null;
  readonly supersedes: string | null;
  readonly expired: boolean;
}

/** The synthetic-data policy artifact as the public route serves it. */
export interface SyntheticDataPolicyFact {
  readonly artifact: string;
  readonly version: string;
  readonly digest: string;
  readonly permittedClasses: readonly string[];
  readonly prohibitedClasses: readonly string[];
  readonly enforcement: readonly { readonly point: string; readonly behavior: string }[];
  readonly violationRecording: string;
}

/** The reset outcome as the public route serves it. */
export interface SandboxResetOutcome {
  readonly identity: SandboxIdentityFact;
  readonly resetOf: string;
  readonly stateCarriedForward: boolean;
  readonly ledgerRecorded: boolean;
}

/** The transport over the four public routes (injectable; env-derived). */
export interface SandboxGovernanceTransport {
  listQuotas(applicationId: string): Promise<SandboxQuotaListFact>;
  getIdentity(applicationId: string, identityId: string): Promise<SandboxIdentityFact | null>;
  resetIdentity(
    applicationId: string,
    identityId: string,
    idempotencyKey: string,
  ): Promise<SandboxResetOutcome>;
  dataPolicy(): Promise<SyntheticDataPolicyFact>;
}

/** A transport-level error carrying the HTTP status (the 422 boundary). */
export class SandboxGovernanceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxGovernanceUnavailableError";
  }
}

async function request<T>(
  fetchImpl: typeof fetch,
  apiUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  const application = (init?.headers as Record<string, string> | undefined)?.["X-Zeck-Application"];
  if (application !== undefined) {
    headers["X-Zeck-Application"] = application;
  }
  const response = await fetchImpl(`${apiUrl}${path}`, { ...init, headers });
  if (response.status === 404) {
    throw new SandboxGovernanceUnavailableError(
      `the sandbox governance route ${path} is not present in this deployment`,
    );
  }
  if (response.status === 422) {
    throw new SandboxGovernanceUnavailableError(
      `the sandbox governance authority is not wired in this deployment (${path} answered the honest 422 — nothing is fabricated in its place)`,
    );
  }
  if (!response.ok) {
    throw new SandboxGovernanceUnavailableError(
      `the sandbox governance route ${path} answered ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export interface SandboxGovernanceTransportOptions {
  /** Injectable fetch — the house rule: apps code never invokes fetch directly. */
  readonly fetchImpl?: typeof fetch;
}

/** Build the transport from the deployment's documented env bindings. */
export function sandboxGovernanceTransportFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: SandboxGovernanceTransportOptions = {},
): SandboxGovernanceTransport | null {
  const apiUrl = env.ZECK_API_URL;
  const token = env.ZECK_TOKEN;
  if (apiUrl === undefined || token === undefined) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async listQuotas(applicationId) {
      return request<SandboxQuotaListFact>(
        fetchImpl,
        apiUrl,
        token,
        `/sandbox/quotas?applicationId=${encodeURIComponent(applicationId)}`,
      );
    },
    async getIdentity(applicationId, identityId) {
      return request<{ identity: SandboxIdentityFact }>(
        fetchImpl,
        apiUrl,
        token,
        `/sandbox/identities/${encodeURIComponent(identityId)}?applicationId=${encodeURIComponent(applicationId)}`,
      ).then((body) => body.identity);
    },
    async resetIdentity(applicationId, identityId, idempotencyKey) {
      return request<SandboxResetOutcome>(
        fetchImpl,
        apiUrl,
        token,
        `/sandbox/identities/${encodeURIComponent(identityId)}/reset?applicationId=${encodeURIComponent(applicationId)}`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({}),
        },
      );
    },
    async dataPolicy() {
      return request<SyntheticDataPolicyFact>(fetchImpl, apiUrl, token, "/sandbox/data-policy");
    },
  };
}

/** The human display of a quota dimension (the platform's own vocabulary). */
export function quotaDimensionLabel(dimension: string): string {
  switch (dimension) {
    case "spend-micro-usd":
      return "Spend (micro-USD)";
    case "wall-clock-ms":
      return "Wall-clock time (ms)";
    case "concurrent-runs":
      return "Concurrent runs";
    case "artifact-count":
      return "Artifact count";
    case "artifact-bytes":
      return "Artifact bytes";
    default:
      return dimension;
  }
}

/** The consumption/limit bar facts (progress in percent, 0..100). */
export function quotaProgressOf(quota: SandboxQuotaFact): number {
  const limit = Number(quota.limit);
  const consumed = Number(quota.consumed);
  if (!Number.isFinite(limit) || !Number.isFinite(consumed) || limit <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((consumed / limit) * 100));
}
