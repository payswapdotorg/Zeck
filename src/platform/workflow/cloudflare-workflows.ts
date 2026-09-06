/**
 * Cloudflare Workflows REST adapter — the production durable-
 * orchestration implementation behind the provider-neutral
 * `WorkflowOrchestrationPort` (WORK-045 / D-04).
 *
 * Cloudflare Workflows speaks a plain JSON-over-HTTPS REST API
 * (verified against the official Cloudflare API reference,
 * developers.cloudflare.com/api/resources/workflows):
 *
 *  - create instance: `POST {api}/accounts/{account_id}/workflows/
 *    {workflow_name}/instances` with body `{"instance_id": <optional
 *    id>, "params": <JSON-encoded string>}` → `{"success": true,
 *    "result": {"id", "status", "version_id", "workflow_id",
 *    "trigger_source"}}`;
 *  - instance details: `GET .../instances/{instance_id}` (query
 *    `simple=true` omits step output) → `{"result": {"status",
 *    "start", "end", "error", "output", "params", "queued",
 *    "step_count", "steps"}}`;
 *  - send event: `POST .../instances/{instance_id}/events/
 *    {event_type}` with body `{"body": <value>}` → `{"result":
 *    {"instanceId", "timestamp"}}`;
 *  - change status (pause / resume / terminate / restart): `PATCH
 *    .../instances/{instance_id}/status` with body
 *    `{"status": "terminate"}` → `{"result": {"status", "timestamp"}}`.
 *
 * The provider's instance-status vocabulary (queued / running /
 * paused / errored / terminated / complete / waitingForPause /
 * waiting / rollingBack) is mapped HERE onto the neutral observation
 * vocabulary and never leaves this file. Cloudflare concepts stop
 * HERE: the domain/application boundary sees only the port (pinned
 * by the architecture tests). No `@cloudflare/*` SDK dependency
 * exists — the adapter is plain `fetch` + Bearer auth, so the SDK
 * boundary table needs no new entries and the provider surface is
 * exactly this file.
 *
 * Provider state is never authority: the adapter reports transport
 * facts (started / observed / signaled / terminated) and fails
 * closed with a typed `WorkflowTransportError` classified
 * `transient` (network, timeout, 429, 5xx — retryable within the
 * bounded budgets) or `permanent` (401/403/404 — credential,
 * permission or resource problems the retry budget cannot fix).
 * Errors NEVER carry the API token or the Authorization header.
 *
 * PROBE DESIGN (the PR #6 discipline, applied to orchestration):
 * `probe()` NEVER runs against the orchestration workflow. It
 * executes its create → observe → terminate round trip on a
 * DEDICATED operator-owned probe workflow (ZECK_WORKFLOW_PROBE_NAME)
 * that carries no application orchestration, and it terminates
 * EXACTLY the one instance it created in that run (exact instance
 * identity). Anything else the probe might observe — an application
 * instance, another probe's instance, foreign noise — is never
 * signaled, never terminated, never mutated in any direction; the
 * probe cannot consume, discard or delay application orchestration
 * by construction (instances are addressed by id; the probe only
 * ever addresses ids it created itself).
 */
import {
  type InstanceObservation,
  type InstanceReceipt,
  type ObservedInstanceStatus,
  type SignalInstanceInput,
  type StartInstanceInput,
  type TerminateInstanceInput,
  WorkflowConfigError,
  type WorkflowOrchestrationPort,
  type WorkflowProviderLimits,
  WorkflowTransportError,
} from "./port";

/** The default Cloudflare API base (overridable for tests/local gateways). */
export const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const EVENT_TYPE_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
/** Cloudflare reserves ids of the form cf_ + exactly 64 lowercase hex. */
const RESERVED_INSTANCE_ID_PATTERN = /^cf_[a-f0-9]{64}$/;

/** Documented provider limits (developers.cloudflare.com/workflows/reference/limits). */
const DOCUMENTED_WORKFLOW_LIMITS: Readonly<Record<string, string>> = Object.freeze({
  maximumEventPayloadSize: "1MiB (2^20 bytes)",
  maximumStatePerInstance: "100MB (Workers Free) / 1GB (Workers Paid)",
  maximumSleepDuration: "365 days (1 year)",
  maximumStepsPerWorkflow: "1024 (Free) / 10000 default, configurable to 25000 (Paid)",
  concurrentInstancesPerAccount: "5 (Free) / 100 (Paid) / 50000 (Enterprise)",
  instanceCreationRate:
    "100 per second (Free) / 300 per second per account, 100 per second per workflow (Paid)",
  completedInstanceStateRetention: "3 days (Free) / 30 days (Paid)",
});

/** The documented maximum event payload size (bytes). */
export const MAX_EVENT_PAYLOAD_BYTES = 1_048_576;

/**
 * Runtime configuration loading for the adapter (repository-defined):
 * the provider endpoint identity (account id + deployed workflow
 * name — provider-account metadata and resource configuration,
 * non-secret) plus the resolved API token secret material. Fail-closed
 * with the exact variable NAMES (never values) when materialization
 * is incomplete.
 */
export function missingCloudflareWorkflowsConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const missing: string[] = [];
  if ((env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "").length === 0) {
    missing.push(
      "ZECK_CLOUDFLARE_ACCOUNT_ID is not set (provider-account metadata; see deploy/manifests/variables.json)",
    );
  }
  if ((env.ZECK_WORKFLOW_NAME ?? "").length === 0) {
    missing.push(
      "ZECK_WORKFLOW_NAME is not set (the environment's deployed workflow name; see deploy/README.md)",
    );
  }
  if ((env.ZECK_WORKFLOW_API_TOKEN ?? "").length === 0) {
    missing.push(
      "ZECK_WORKFLOW_API_TOKEN is not set (the materialized workflow-api-token secret value; the reference binding is ZECK_SECRET_WORKFLOW_API_TOKEN_REF)",
    );
  }
  return missing;
}

/** Load the adapter runtime configuration from the environment (fail closed). */
export function loadCloudflareWorkflowsRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): CloudflareWorkflowsConfig {
  const missing = missingCloudflareWorkflowsConfiguration(env);
  if (missing.length > 0) {
    throw new WorkflowConfigError(
      `workflow orchestration configuration is incomplete: ${missing.join("; ")}`,
    );
  }
  const timeoutRaw = env.ZECK_WORKFLOW_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs =
    timeoutRaw === undefined || timeoutRaw.trim().length === 0
      ? undefined
      : readPositiveInt(timeoutRaw, "ZECK_WORKFLOW_REQUEST_TIMEOUT_MS");
  // The dedicated probe workflow (optional: the orchestration surface
  // itself never needs it — only probe() does, and probe() refuses
  // fail-closed without it rather than ever touching the
  // orchestration workflow).
  const probeNameRaw = env.ZECK_WORKFLOW_PROBE_NAME;
  const probeWorkflowName =
    probeNameRaw === undefined || probeNameRaw.trim().length === 0
      ? undefined
      : probeNameRaw.trim();
  if (probeWorkflowName !== undefined && !WORKFLOW_NAME_PATTERN.test(probeWorkflowName)) {
    throw new WorkflowConfigError(
      "ZECK_WORKFLOW_PROBE_NAME must be a Cloudflare workflow name (the dedicated operator-owned probe workflow; see deploy/README.md)",
    );
  }
  return {
    apiBaseUrl: env.ZECK_WORKFLOW_API_BASE_URL,
    accountId: env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "",
    workflowName: env.ZECK_WORKFLOW_NAME ?? "",
    probeWorkflowName,
    apiToken: env.ZECK_WORKFLOW_API_TOKEN ?? "",
    requestTimeoutMs,
  };
}

function readPositiveInt(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowConfigError(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

export interface CloudflareWorkflowsConfig {
  /**
   * API base URL. Defaults to the public Cloudflare API; tests point
   * it at an in-process protocol server.
   */
  readonly apiBaseUrl?: string;
  /** Cloudflare account id (provider-account metadata, non-secret). */
  readonly accountId: string;
  /** The deployed workflow name the orchestration instances run on. */
  readonly workflowName: string;
  /**
   * The DEDICATED operator-owned probe workflow name (non-secret;
   * `ZECK_WORKFLOW_PROBE_NAME`). Optional: start/observe/signal/
   * terminate never need it — only `probe()` does, and `probe()`
   * fails closed without it. Must differ from `workflowName` (a
   * probe workflow that IS the orchestration workflow is rejected —
   * the probe must never touch application orchestration).
   */
  readonly probeWorkflowName?: string;
  /**
   * API token — resolved secret material (`workflow-api-token`
   * secret, materialized in the environment as
   * ZECK_WORKFLOW_API_TOKEN). Never a repository value; never
   * logged; never in an error message.
   */
  readonly apiToken: string;
  /** Per-request timeout (milliseconds). */
  readonly requestTimeoutMs?: number;
  /** Injectable transport (tests substitute a local protocol server). */
  readonly fetchImpl?: typeof fetch;
}

/** Validates the configuration fail-closed (before any wire call). */
export function validateCloudflareWorkflowsConfig(config: CloudflareWorkflowsConfig): void {
  const problems: string[] = [];
  const baseUrl = config.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE_URL;
  if (!/^https?:\/\//.test(baseUrl) || baseUrl.includes(" ")) {
    problems.push("apiBaseUrl must be an http(s) URL");
  }
  if (baseUrl.endsWith("/")) {
    problems.push("apiBaseUrl must not end with a slash");
  }
  if (!ACCOUNT_ID_PATTERN.test(config.accountId)) {
    problems.push("accountId must be a 32-hex Cloudflare account id");
  }
  if (!WORKFLOW_NAME_PATTERN.test(config.workflowName)) {
    problems.push("workflowName must be 1-64 characters of [A-Za-z0-9_-]");
  }
  if (config.apiToken.length === 0) {
    problems.push("apiToken is required (resolved secret material; never empty in production)");
  }
  if (config.probeWorkflowName !== undefined) {
    if (!WORKFLOW_NAME_PATTERN.test(config.probeWorkflowName)) {
      problems.push(
        "probeWorkflowName must be a Cloudflare workflow name (the dedicated probe workflow)",
      );
    } else if (config.probeWorkflowName === config.workflowName) {
      problems.push(
        "probeWorkflowName must differ from workflowName — the probe workflow is dedicated operator-owned infrastructure and must never be the orchestration workflow",
      );
    }
  }
  const timeout = config.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
    problems.push("requestTimeoutMs must be an integer in [100, 120000]");
  }
  if (problems.length > 0) {
    throw new WorkflowConfigError(
      `invalid Cloudflare Workflows configuration: ${problems.join("; ")}`,
    );
  }
}

/**
 * The provider-neutral instance-status mapping (the ONLY place the
 * provider's status vocabulary appears).
 */
function mapInstanceStatus(raw: unknown): ObservedInstanceStatus {
  if (typeof raw !== "string") {
    return "unknown";
  }
  switch (raw) {
    case "running":
    case "queued":
    case "waiting":
    case "waitingForPause":
    case "rollingBack":
      return "active";
    case "paused":
      return "paused";
    case "errored":
      return "errored";
    case "terminated":
      return "terminated";
    case "complete":
      return "complete";
    default:
      return "unknown";
  }
}

/**
 * Build the provider-neutral `WorkflowOrchestrationPort` over the
 * Cloudflare Workflows REST API. The returned object also exposes
 * `probe()` — the real orchestration round-trip probe used by deploy
 * smoke and the deploy/workflow tool (create → observe → terminate
 * on the DEDICATED operator-owned probe workflow; touches exactly
 * the one instance it created in that run).
 */
export function createCloudflareWorkflowsTransport(
  config: CloudflareWorkflowsConfig,
): WorkflowOrchestrationPort & { probe(): Promise<{ ok: true; detail: string }> } {
  validateCloudflareWorkflowsConfig(config);
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const doFetch = config.fetchImpl ?? fetch;

  /** Credential-shaped material never enters any error message. */
  const safeDetail = (text: string): string =>
    text
      .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer [redacted]")
      .replace(config.apiToken, "[redacted]")
      .slice(0, 200);

  async function request(
    workflowName: string,
    path: string,
    init: { readonly method: string; readonly body?: unknown },
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await doFetch(
        `${baseUrl}/accounts/${config.accountId}/workflows/${workflowName}${path}`,
        {
          method: init.method,
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      // Network-level failure (DNS, refused, timeout): transient by
      // definition — an unavailable provider, never a silent success.
      throw new WorkflowTransportError(
        `workflow transport request failed (${safeDetail((error as Error).message)})`,
        "transient",
      );
    }
    let json: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  /** Cloudflare API error extraction (codes, never secret material). */
  function providerError(json: unknown): { code: string | null; message: string | null } {
    if (json === null || typeof json !== "object") {
      return { code: null, message: null };
    }
    const record = json as Record<string, unknown>;
    const errors = record.errors;
    if (Array.isArray(errors) && errors.length > 0 && typeof errors[0] === "object") {
      const first = errors[0] as Record<string, unknown>;
      const code =
        typeof first.code === "number" || typeof first.code === "string"
          ? String(first.code)
          : null;
      const message = typeof first.message === "string" ? first.message : null;
      return { code, message: message === null ? null : safeDetail(message) };
    }
    return { code: null, message: null };
  }

  /**
   * Fail closed on a non-2xx answer, classified:
   *  - 401/403: credential/permission rejected (permanent);
   *  - 404: workflow or instance resource does not exist (permanent);
   *  - 429/5xx and everything else unexpected: transient (retryable
   *    within the bounded budget).
   */
  function failClosed(status: number, json: unknown, operation: string): never {
    const { code, message } = providerError(json);
    const kind = status === 401 || status === 403 || status === 404 ? "permanent" : "transient";
    throw new WorkflowTransportError(
      `workflow ${operation} rejected (http ${status}${code === null ? "" : `, provider code ${code}`}${message === null ? "" : `: ${message}`})`,
      kind,
      { status, providerCode: code },
    );
  }

  /** Unwrap the documented envelope and require success. */
  function requireSuccess(json: unknown, operation: string): Record<string, unknown> {
    if (json === null || typeof json !== "object") {
      throw new WorkflowTransportError(
        `workflow ${operation} returned a malformed envelope`,
        "transient",
      );
    }
    const record = json as Record<string, unknown>;
    if (record.success !== true) {
      const { code, message } = providerError(json);
      throw new WorkflowTransportError(
        `workflow ${operation} reported failure${code === null ? "" : ` (provider code ${code})`}${message === null ? "" : `: ${message}`}`,
        "transient",
        { providerCode: code },
      );
    }
    if (record.result === null || typeof record.result !== "object") {
      throw new WorkflowTransportError(
        `workflow ${operation} envelope missing result`,
        "transient",
      );
    }
    return record.result as Record<string, unknown>;
  }

  /** Fail closed on payloads beyond the documented provider bound. */
  function enforcePayloadBytes(canonical: string, what: string): void {
    if (canonical.length > MAX_EVENT_PAYLOAD_BYTES) {
      throw new WorkflowConfigError(
        `${what} is ${canonical.length} bytes; the documented provider limit is ${MAX_EVENT_PAYLOAD_BYTES} (reference-only payloads keep Zeck far below it — see the workflow state bounds)`,
      );
    }
  }

  function requireValidInstanceHint(hint: string): void {
    if (!INSTANCE_ID_PATTERN.test(hint) || RESERVED_INSTANCE_ID_PATTERN.test(hint)) {
      throw new WorkflowConfigError(
        "instanceHint must be 1-100 characters of [A-Za-z0-9_-] and must not use the provider's reserved id form",
      );
    }
  }

  return {
    async startInstance(input: StartInstanceInput): Promise<InstanceReceipt> {
      requireValidInstanceHint(input.instanceHint);
      const params = JSON.stringify(input.params);
      enforcePayloadBytes(params, "instance params");
      const { status, json } = await request(config.workflowName, "/instances", {
        method: "POST",
        body: { instance_id: input.instanceHint, params },
      });
      if (status < 200 || status >= 300) {
        failClosed(status, json, "instance start");
      }
      const result = requireSuccess(json, "instance start");
      const id = result.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new WorkflowTransportError(
          "workflow instance start envelope missing result.id",
          "transient",
        );
      }
      return { instanceId: id };
    },

    async describeInstance(instanceId: string): Promise<InstanceObservation> {
      if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new WorkflowConfigError("instanceId must be 1-100 characters of [A-Za-z0-9_-]");
      }
      const { status, json } = await request(
        config.workflowName,
        `/instances/${instanceId}?simple=true`,
        { method: "GET" },
      );
      if (status < 200 || status >= 300) {
        failClosed(status, json, "instance describe");
      }
      const result = requireSuccess(json, "instance describe");
      const error = result.error;
      const errorDetail =
        error !== null && typeof error === "object"
          ? safeDetail(String((error as Record<string, unknown>).message ?? ""))
          : null;
      return {
        status: mapInstanceStatus(result.status),
        detail: errorDetail !== null && errorDetail.length > 0 ? errorDetail : null,
      };
    },

    async signalInstance(input: SignalInstanceInput): Promise<void> {
      if (!INSTANCE_ID_PATTERN.test(input.instanceId)) {
        throw new WorkflowConfigError("instanceId must be 1-100 characters of [A-Za-z0-9_-]");
      }
      if (!EVENT_TYPE_PATTERN.test(input.eventType)) {
        throw new WorkflowConfigError(
          "eventType must be 1-100 characters of [A-Za-z0-9._-] (the documented provider bound)",
        );
      }
      const body = JSON.stringify(input.body);
      enforcePayloadBytes(body, "signal body");
      const { status, json } = await request(
        config.workflowName,
        `/instances/${input.instanceId}/events/${input.eventType}`,
        { method: "POST", body: { body: input.body } },
      );
      if (status < 200 || status >= 300) {
        failClosed(status, json, "instance signal");
      }
      requireSuccess(json, "instance signal");
    },

    async terminateInstance(input: TerminateInstanceInput): Promise<void> {
      if (!INSTANCE_ID_PATTERN.test(input.instanceId)) {
        throw new WorkflowConfigError("instanceId must be 1-100 characters of [A-Za-z0-9_-]");
      }
      const { status, json } = await request(
        config.workflowName,
        `/instances/${input.instanceId}/status`,
        { method: "PATCH", body: { status: "terminate" } },
      );
      if (status < 200 || status >= 300) {
        failClosed(status, json, "instance terminate");
      }
      requireSuccess(json, "instance terminate");
    },

    describeLimits(): WorkflowProviderLimits {
      return {
        documented: DOCUMENTED_WORKFLOW_LIMITS,
        maxPayloadBytes: MAX_EVENT_PAYLOAD_BYTES,
        supportsTermination: true,
      };
    },

    /**
     * The real orchestration round-trip probe (deploy smoke +
     * deploy/workflow probe): create a self-identifying probe
     * instance on the DEDICATED operator-owned probe workflow,
     * observe it, terminate EXACTLY that one instance. Proves
     * create+observe+terminate against the real provider on workflow
     * infrastructure that carries no application orchestration.
     *
     * SAFETY INVARIANT (the PR #6 discipline): the probe never runs
     * against the orchestration workflow and never signals, mutates
     * or terminates an instance it did not create in this run.
     * Application instances are addressed by ids the probe never
     * learns; a probe workflow equal to the orchestration workflow is
     * rejected fail-closed (at configuration validation and again at
     * probe time), so probe traffic can neither consume, discard nor
     * delay genuine orchestration.
     */
    async probe(): Promise<{ ok: true; detail: string }> {
      const probeWorkflowName = config.probeWorkflowName;
      if (probeWorkflowName === undefined || probeWorkflowName.length === 0) {
        // Fail closed: probing the orchestration workflow is not an option.
        throw new WorkflowConfigError(
          "workflow orchestration probe requires a dedicated probe workflow (ZECK_WORKFLOW_PROBE_NAME is not set; the probe never targets the orchestration workflow — see deploy/README.md)",
        );
      }
      if (probeWorkflowName === config.workflowName) {
        // Defense-in-depth: construction already rejects this; refuse
        // again here so no call path can ever probe the orchestration
        // workflow.
        throw new WorkflowConfigError(
          "the probe workflow must be dedicated and distinct from the orchestration workflow (ZECK_WORKFLOW_PROBE_NAME must differ from ZECK_WORKFLOW_NAME)",
        );
      }
      const probeTag = `zeck-orchestration-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      // 1. Create the probe's OWN instance on the probe workflow.
      const { status: createStatus, json: createJson } = await request(
        probeWorkflowName,
        "/instances",
        {
          method: "POST",
          body: {
            instance_id: `zeck-probe-${probeTag.slice(-24)}`,
            params: JSON.stringify({ probe: probeTag }),
          },
        },
      );
      if (createStatus < 200 || createStatus >= 300) {
        failClosed(createStatus, createJson, "probe instance start");
      }
      const created = requireSuccess(createJson, "probe instance start");
      const probeInstanceId = created.id;
      if (typeof probeInstanceId !== "string" || probeInstanceId.length === 0) {
        throw new WorkflowTransportError(
          "probe instance start envelope missing result.id",
          "transient",
        );
      }
      // 2. Observe EXACTLY that instance.
      const { status: describeStatus, json: describeJson } = await request(
        probeWorkflowName,
        `/instances/${probeInstanceId}?simple=true`,
        { method: "GET" },
      );
      if (describeStatus < 200 || describeStatus >= 300) {
        failClosed(describeStatus, describeJson, "probe instance describe");
      }
      const described = requireSuccess(describeJson, "probe instance describe");
      const observed = mapInstanceStatus(described.status);
      // 3. Terminate EXACTLY that instance (bounded provider state).
      const { status: terminateStatus, json: terminateJson } = await request(
        probeWorkflowName,
        `/instances/${probeInstanceId}/status`,
        { method: "PATCH", body: { status: "terminate" } },
      );
      if (terminateStatus < 200 || terminateStatus >= 300) {
        failClosed(terminateStatus, terminateJson, "probe instance terminate");
      }
      requireSuccess(terminateJson, "probe instance terminate");
      return {
        ok: true,
        detail: `workflow orchestration round-trip verified on the dedicated probe workflow (create+observe+terminate); exactly one probe instance terminated (observed ${observed})`,
      };
    },
  };
}
