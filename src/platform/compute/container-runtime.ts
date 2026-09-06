/**
 * Container runtime client over the documented Zeck container-runner
 * REST protocol (platform compute plane; WORK-046, D-05).
 *
 * THE concrete `ContainerRuntimeClient` of the v1.0 container
 * `ComputeEnvironment` (`src/platform/sandbox/runtime-client.ts`): a
 * container-runner daemon (a dedicated execution-plane host process —
 * first-party fleet runner or a governed customer runner) implements
 * the protocol; this adapter speaks it over plain `fetch` (ZERO new
 * SDKs — the sanctioned runtime import set of `src/` is unchanged).
 *
 * THE PROTOCOL (documented normatively in deploy/README.md §D-05):
 *
 *   POST {base}/v1/runs
 *        Authorization: Bearer <token>
 *        {"runId": "<uuid>", "config": <ContainerConfiguration>, "timeoutMs": <int>}
 *        -> 202 {"runId": "...", "accepted": true}
 *        -> 400 (malformed config; PERMANENT) / 401 / 403 (auth; PERMANENT)
 *
 *   GET {base}/v1/runs/{runId}
 *        Authorization: Bearer <token>
 *        -> 200 {"status": "running"}
 *        -> 200 {"status": "succeeded"|"failed", "exitCode": <int>,
 *                "timedOut": <bool>, "stdout": "<bounded>", "stderr": "<bounded>",
 *                "durationMs": <int>}
 *        -> 404 (the runner no longer knows the run — PERMANENT, fail
 *           closed; the honest unknown-outcome class)
 *
 * Failure classification (fail closed everywhere):
 *   - 400/401/403/404 + malformed envelopes        -> permanent
 *   - 429/5xx/network/timeout/poll-deadline        -> transient (bounded
 *     retries by the caller; the run itself is bounded by the admitted
 *     executionTimeoutMs on the runner side)
 *
 * SECURITY POSTURE: the client sends ONLY the already-validated
 * `ContainerConfiguration` (the sandbox module validated the escape
 * profile BEFORE the runtime is consulted — a configuration the
 * validator would reject never reaches the wire). The token never
 * enters any error. stdout/stderr are bounded by the client
 * (truncation to the output bound; the digest is computed over the
 * BOUNDED payload — deterministic evidence).
 */
import { createHash } from "node:crypto";
import type { ContainerConfiguration } from "../sandbox/container-profile";
import type {
  ContainerRunOptions,
  ContainerRunResult,
  ContainerRuntimeClient,
} from "../sandbox/runtime-client";

/** Provider-neutral runtime transport error (fail closed). */
export type ContainerRuntimeFailureKind = "transient" | "permanent";

export class ContainerRuntimeError extends Error {
  readonly failureKind: ContainerRuntimeFailureKind;
  readonly status: number | null;
  readonly providerCode: string | null;

  constructor(
    message: string,
    failureKind: ContainerRuntimeFailureKind,
    options?: { readonly status?: number; readonly providerCode?: string | null },
  ) {
    super(message);
    this.name = "ContainerRuntimeError";
    this.failureKind = failureKind;
    this.status = options?.status ?? null;
    this.providerCode = options?.providerCode ?? null;
  }
}

/** Invalid runtime configuration (fail closed before any wire call). */
export class ContainerRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerRuntimeConfigError";
  }
}

export interface ContainerRuntimeClientConfig {
  /** The runner's base URL (http(s)). Required — absent fails closed. */
  readonly baseUrl: string;
  /** The runner API token (credential-shaped; environment-only materialization). */
  readonly apiToken: string;
  /** Per-request HTTP timeout (ms). Bounded [100, 120000]; default 10000. */
  readonly requestTimeoutMs?: number;
  /** Poll interval while a run is executing (ms). Bounded [50, 5000]; default 250. */
  readonly pollIntervalMs?: number;
  /**
   * Bounded stdout/stderr payload size (bytes). Bounded [256, 65536];
   * default 4096. The runner MAY return less; the client truncates to
   * exactly this bound.
   */
  readonly maxOutputBytes?: number;
  /** Sleep seam (tests substitute a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const REQUEST_TIMEOUT_BOUNDS = { min: 100, max: 120_000 } as const;
const POLL_INTERVAL_BOUNDS = { min: 50, max: 5_000 } as const;
const MAX_OUTPUT_BOUNDS = { min: 256, max: 65_536 } as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_OUTPUT_BYTES = 4_096;

/** Validate the runtime client configuration (fail closed). */
export function validateContainerRuntimeConfig(
  config: ContainerRuntimeClientConfig,
): ContainerRuntimeClientConfig {
  if (
    typeof config.baseUrl !== "string" ||
    !/^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?(\/[^\s]*)?$/.test(config.baseUrl)
  ) {
    throw new ContainerRuntimeConfigError(
      "container runner baseUrl must be an http(s) URL (ZECK_CONTAINER_RUNNER_URL)",
    );
  }
  if (typeof config.apiToken !== "string" || config.apiToken.length === 0) {
    throw new ContainerRuntimeConfigError(
      "container runner apiToken must be materialized (ZECK_CONTAINER_RUNNER_API_TOKEN; the secret reference is ZECK_SECRET_CONTAINER_RUNNER_TOKEN_REF)",
    );
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < REQUEST_TIMEOUT_BOUNDS.min ||
    requestTimeoutMs > REQUEST_TIMEOUT_BOUNDS.max
  ) {
    throw new ContainerRuntimeConfigError(
      `requestTimeoutMs must be bounded [${REQUEST_TIMEOUT_BOUNDS.min}, ${REQUEST_TIMEOUT_BOUNDS.max}]`,
    );
  }
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < POLL_INTERVAL_BOUNDS.min ||
    pollIntervalMs > POLL_INTERVAL_BOUNDS.max
  ) {
    throw new ContainerRuntimeConfigError(
      `pollIntervalMs must be bounded [${POLL_INTERVAL_BOUNDS.min}, ${POLL_INTERVAL_BOUNDS.max}]`,
    );
  }
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < MAX_OUTPUT_BOUNDS.min ||
    maxOutputBytes > MAX_OUTPUT_BOUNDS.max
  ) {
    throw new ContainerRuntimeConfigError(
      `maxOutputBytes must be bounded [${MAX_OUTPUT_BOUNDS.min}, ${MAX_OUTPUT_BOUNDS.max}]`,
    );
  }
  return config;
}

interface RunStatusBody {
  readonly status?: unknown;
  readonly exitCode?: unknown;
  readonly timedOut?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly durationMs?: unknown;
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Truncate to the byte bound on a character boundary. */
function truncateToBound(value: string, maxBytes: number): string {
  const buffered = Buffer.from(value, "utf8");
  if (buffered.length <= maxBytes) {
    return value;
  }
  let slice = buffered.subarray(0, maxBytes);
  // Avoid splitting a UTF-8 sequence at the boundary.
  while (slice.length > 0 && (slice[slice.length - 1] as number) >= 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return slice.toString("utf8");
}

/**
 * Build the container-runtime client for one runner endpoint. The
 * client is the runtime identity (`runtimeId` names the endpoint for
 * evidence — never a vendor SDK type).
 */
export function createContainerRuntimeClient(
  config: ContainerRuntimeClientConfig,
): ContainerRuntimeClient {
  const validated = validateContainerRuntimeConfig(config);
  const base = validated.baseUrl.replace(/\/+$/, "");
  const token = validated.apiToken;
  const requestTimeoutMs = validated.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = validated.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxOutputBytes = validated.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const sleep = validated.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const classifyStatus = (status: number): ContainerRuntimeFailureKind => {
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return "permanent";
    }
    return "transient";
  };

  const request = async (
    path: string,
    init: { readonly method: "POST" | "GET"; readonly body?: string },
  ): Promise<{ readonly status: number; readonly text: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      // Network/timeout: transient (the caller's bounded budget decides).
      throw new ContainerRuntimeError(
        `container runner request failed (${path}): ${error instanceof Error ? error.message : String(error)}`,
        "transient",
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    runtimeId: `container-runner:${base}`,

    async run(
      configuration: ContainerConfiguration,
      options: ContainerRunOptions,
    ): Promise<ContainerRunResult> {
      const runId = `run-${sha256Hex(JSON.stringify([configuration, options.timeoutMs])).slice(0, 32)}`;
      // 1. Submit the run (the config is ALREADY validated by the
      //    sandbox module's escape validator — the client sends it as-is).
      const submission = await request("/v1/runs", {
        method: "POST",
        body: JSON.stringify({ runId, config: configuration, timeoutMs: options.timeoutMs }),
      });
      if (submission.status !== 202) {
        if (submission.status === 409) {
          // A prior submission of the SAME deterministic run id: the
          // runner already holds it — poll it (idempotent submission).
        } else {
          throw new ContainerRuntimeError(
            `container runner rejected the run submission (http ${submission.status})`,
            classifyStatus(submission.status),
            { status: submission.status },
          );
        }
      }

      // 2. Poll within the admitted wall-clock bound (the deadline is
      //    the run's own timeout plus a bounded observation slack).
      const deadline = Date.now() + options.timeoutMs + requestTimeoutMs * 2 + pollIntervalMs * 4;
      for (;;) {
        const observation = await request(`/v1/runs/${runId}`, { method: "GET" });
        if (observation.status === 404) {
          throw new ContainerRuntimeError(
            `container runner no longer knows run ${runId} (http 404); the honest unknown-outcome class fails closed`,
            "permanent",
            { status: 404 },
          );
        }
        if (observation.status !== 200) {
          throw new ContainerRuntimeError(
            `container runner observation failed (http ${observation.status})`,
            classifyStatus(observation.status),
            { status: observation.status },
          );
        }
        let body: RunStatusBody;
        try {
          body = JSON.parse(observation.text) as RunStatusBody;
        } catch {
          throw new ContainerRuntimeError(
            "container runner returned a malformed status envelope (fail closed)",
            "permanent",
          );
        }
        if (body.status === "running") {
          if (Date.now() >= deadline) {
            throw new ContainerRuntimeError(
              `container run ${runId} exceeded its observation deadline; treated as the bounded timeout`,
              "transient",
            );
          }
          await sleep(pollIntervalMs);
          continue;
        }
        if (body.status === "succeeded" || body.status === "failed") {
          const stdout = truncateToBound(
            typeof body.stdout === "string" ? body.stdout : "",
            maxOutputBytes,
          );
          const stderr = truncateToBound(
            typeof body.stderr === "string" ? body.stderr : "",
            maxOutputBytes,
          );
          const exitCode = typeof body.exitCode === "number" ? Math.trunc(body.exitCode) : -1;
          return {
            exitCode,
            timedOut: body.timedOut === true,
            stdout,
            stderr,
            stdoutDigest: sha256Hex(stdout),
            durationMs:
              typeof body.durationMs === "number" && Number.isFinite(body.durationMs)
                ? Math.max(0, Math.trunc(body.durationMs))
                : 0,
          };
        }
        throw new ContainerRuntimeError(
          `container runner reported unknown run status ${String(body.status)} (fail closed)`,
          "permanent",
        );
      }
    },
  };
}

/**
 * The runner reachability + authentication probe: an authenticated GET
 * for a run id that cannot exist. The EXPECTED answer is 404 (auth
 * accepted; the run is unknown) — a 401/403 proves broken credentials,
 * 5xx/network proves unreachability. The probe never executes anything
 * and never touches application runs.
 */
export async function probeContainerRunner(
  config: ContainerRuntimeClientConfig,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const validated = validateContainerRuntimeConfig(config);
  const base = validated.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), validated.requestTimeoutMs ?? 10_000);
  try {
    const response = await fetch(`${base}/v1/runs/00000000-0000-0000-0000-000000000000`, {
      method: "GET",
      headers: { Authorization: `Bearer ${validated.apiToken}` },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return {
        ok: true,
        detail: `runner answered 404 for the synthetic run id (authenticated; wire + auth verified without executing anything)`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        detail: `runner rejected the credential (http ${response.status}); the token binding must be repaired before dispatching compute`,
      };
    }
    return {
      ok: false,
      detail: `runner answered http ${response.status} for the synthetic probe (fail closed)`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `runner unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
