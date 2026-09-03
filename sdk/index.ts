/**
 * Zeck SDK — the public developer contract of AI Execution OS
 * (WORK-015 / API-002; `spec/architecture.md` §2.1, ADR-0001/0002).
 *
 * THE SDK IS EXECUTION-CENTRIC (API-002): the stable public primitive is
 * an `Execution`, never a model call, never a provider call. The wire
 * types are the ONE canonical contract in `src/shared/wire.ts` (shared
 * by the API transport and this SDK — no duplication, contract drift is
 * impossible by construction); this package re-exports them as the
 * client-side contract and adds the execution-centric client, the
 * webhook signature verification helper and the receiver idempotency
 * guidance.
 *
 * PROVIDER NEUTRALITY (M17): there is NO provider SDK concept here — no
 * vendor model types, no connection handles. Developers express
 * a task + constraints; Zeck owns execution planning (provider/model
 * identifiers cross ONLY as opaque neutral strings inside route
 * summaries, exactly like the policy restriction vocabulary).
 *
 * SECRET SAFETY (M5): no SDK type carries secret material. Credentials
 * are BYOK references handled server-side by the platform; the SDK
 * surface has no field where a plaintext secret could even appear.
 *
 * APPLICATION SCOPE (WORK-034): every scoped client method sends the
 * canonical X-Zeck-Application selector (`ZECK_APPLICATION_HEADER`) from
 * the client's `applicationId` scope — the real API derives the effective
 * scope server-side and rejects scoped requests without it. A client
 * without a scope fails fast client-side on scoped calls. Creation keeps
 * its per-request `applicationId` in the request body.
 */

export * from "../src/shared/wire";

import type { ExecutionReceipt, ExecutionRequest, PublicError } from "../src/shared/wire";
import {
  FORBIDDEN_REQUEST_KEYS,
  webhookSignatureBasis,
  ZECK_APPLICATION_HEADER,
} from "../src/shared/wire";

// ---------------------------------------------------------------------------
// Execution-centric client (fetch-based, provider-neutral)
// ---------------------------------------------------------------------------

export interface ZeckClientOptions {
  /** Base URL of the Zeck API (e.g. https://api.zeck.example). */
  readonly baseUrl: string;
  /** Bearer credential for the Zeck transport (never a provider key). */
  readonly token: string;
  /**
   * The application whose scope authorizes scoped reads and governed
   * commands (WORK-034): sent as the canonical X-Zeck-Application header
   * on every scoped client method — the real API derives the effective
   * tenant/application scope server-side from that selector and rejects
   * scoped requests without it. Optional only at construction: a scoped
   * method called on a client without an application scope fails fast
   * client-side (the wire contract is pinned, never discovered).
   * Creation keeps its per-request `applicationId` in the request body.
   */
  readonly applicationId?: string;
  readonly fetchImpl?: typeof fetch;
  /** Default idempotency key generator for create-style calls. */
  readonly generateIdempotencyKey?: () => string;
}

export class ZeckApiError extends Error {
  readonly body: PublicError;
  readonly status: number;

  constructor(status: number, body: PublicError) {
    super(body.message);
    this.name = "ZeckApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ZeckClient {
  createExecution(
    request: ExecutionRequest,
    idempotencyKey?: string,
  ): Promise<{ readonly receipt: ExecutionReceipt }>;
  getExecution(executionId: string): Promise<import("../src/shared/wire").Execution>;
  cancelExecution(executionId: string, idempotencyKey?: string): Promise<ExecutionReceipt>;
  getResult(executionId: string): Promise<import("../src/shared/wire").ExecutionResult>;
  listEvents(executionId: string): Promise<readonly import("../src/shared/wire").ExecutionEvent[]>;
  listVerification(
    executionId: string,
  ): Promise<readonly import("../src/shared/wire").VerificationResult[]>;
  listAgents(): Promise<readonly import("../src/shared/wire").AgentSummary[]>;
  getAgentStatus(agentId: string): Promise<import("../src/shared/wire").AgentStatusView>;
}

function assertNoProviderSelection(request: ExecutionRequest): void {
  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (key in request) {
      throw new Error(
        `execution request must not select a provider/model/rail/agent (API-001): unexpected key "${key}"`,
      );
    }
  }
}

/** Create the execution-centric Zeck client (fetch-based). */
export function createZeckClient(options: ZeckClientOptions): ZeckClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const generateKey =
    options.generateIdempotencyKey ?? (() => `sdk-${globalThis.crypto.randomUUID()}`);
  const applicationScope = options.applicationId;
  if (applicationScope !== undefined && applicationScope.trim().length === 0) {
    throw new Error(
      "ZeckClientOptions.applicationId must be a non-empty string (the application whose scope authorizes scoped reads)",
    );
  }
  /**
   * The application-scope selector for the next scoped call: fails fast
   * client-side when the client carries no scope (WORK-034) — mirroring
   * the server-side requirement, the same way provider-selection attempts
   * are rejected before the wire (API-001). Never a wire failure: the
   * request is not issued.
   */
  const requireApplicationScope = (): string => {
    if (applicationScope === undefined) {
      throw new Error(
        "this client has no application scope: construct it with ZeckClientOptions.applicationId (every scoped read and governed command sends it as the X-Zeck-Application header the API requires)",
      );
    }
    return applicationScope;
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> => {
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let parsed: PublicError | null = null;
      try {
        parsed = (await response.json()) as PublicError;
      } catch {
        parsed = null;
      }
      throw new ZeckApiError(
        response.status,
        parsed ?? {
          code: "PROVIDER_ERROR",
          message: `unexpected transport failure (HTTP ${response.status})`,
          retryable: response.status >= 500,
        },
      );
    }
    return (await response.json()) as T;
  };

  return {
    async createExecution(executionRequest, idempotencyKey) {
      assertNoProviderSelection(executionRequest);
      const key = idempotencyKey ?? generateKey();
      const receipt = await request<ExecutionReceipt>("POST", "/executions", executionRequest, {
        "idempotency-key": key,
      });
      return { receipt };
    },
    async getExecution(executionId) {
      return request<import("../src/shared/wire").Execution>(
        "GET",
        `/executions/${encodeURIComponent(executionId)}`,
        undefined,
        { [ZECK_APPLICATION_HEADER]: requireApplicationScope() },
      );
    },
    async cancelExecution(executionId, idempotencyKey) {
      const key = idempotencyKey ?? generateKey();
      return request<ExecutionReceipt>(
        "POST",
        `/executions/${encodeURIComponent(executionId)}/cancel`,
        {},
        {
          "idempotency-key": key,
          [ZECK_APPLICATION_HEADER]: requireApplicationScope(),
        },
      );
    },
    async getResult(executionId) {
      return request<import("../src/shared/wire").ExecutionResult>(
        "GET",
        `/executions/${encodeURIComponent(executionId)}/results`,
        undefined,
        { [ZECK_APPLICATION_HEADER]: requireApplicationScope() },
      );
    },
    async listEvents(executionId) {
      return request<readonly import("../src/shared/wire").ExecutionEvent[]>(
        "GET",
        `/executions/${encodeURIComponent(executionId)}/events`,
        undefined,
        { [ZECK_APPLICATION_HEADER]: requireApplicationScope() },
      );
    },
    async listVerification(executionId) {
      return request<readonly import("../src/shared/wire").VerificationResult[]>(
        "GET",
        `/executions/${encodeURIComponent(executionId)}/verification`,
        undefined,
        { [ZECK_APPLICATION_HEADER]: requireApplicationScope() },
      );
    },
    async listAgents() {
      return request<readonly import("../src/shared/wire").AgentSummary[]>(
        "GET",
        "/agents",
        undefined,
        {
          [ZECK_APPLICATION_HEADER]: requireApplicationScope(),
        },
      );
    },
    async getAgentStatus(agentId) {
      return request<import("../src/shared/wire").AgentStatusView>(
        "GET",
        `/agents/${encodeURIComponent(agentId)}/status`,
        undefined,
        { [ZECK_APPLICATION_HEADER]: requireApplicationScope() },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Receiver-side webhook verification (API-004/M9: never trust unsigned)
// ---------------------------------------------------------------------------

/**
 * Verify a webhook signature (HMAC-SHA256 over the documented signature
 * basis). Receivers MUST verify before trusting a payload — an unsigned
 * webhook is never trusted (M9). Uses the Web Crypto API (portable to
 * browsers, edge runtimes and Bun/Node 18+).
 */
export async function verifyWebhookSignature(
  event: import("../src/shared/wire").WebhookEvent,
  signatureHex: string,
  secret: string,
  cryptoImpl: { readonly subtle: Crypto["subtle"] } = { subtle: globalThis.crypto.subtle },
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    encoder.encode(webhookSignatureBasis(event)),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return expected === signatureHex.toLowerCase();
}
