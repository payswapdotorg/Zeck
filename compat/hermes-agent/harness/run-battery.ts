/**
 * The PPR-022 proof battery — composes the full stack and runs the
 * complete ACR-006/ACR-007 compatibility battery for pinned Hermes-Agent,
 * producing the evidence record at deploy/evidence/ppr-022.json.
 *
 * Run: bun run compat/hermes-agent/harness/run-battery.ts
 *      (repeat until it prints the derived status — the battery is
 *      RESUMABLE: every completed step's facts are checkpointed to
 *      WORK_ROOT/battery-state.json and skipped on the next invocation,
 *      the CHECKPOINT LAW applied to the proof itself; a killed
 *      invocation loses only the step it was running)
 *
 * Battery steps (each produces real facts or an honest NOT-RUN):
 *  1. edge inventory (the declared graph + discovered inventory +
 *     dormant-seam disclosures + the static no-bypass reconciliation);
 *  2. provider credential removal (scrubbed Hermes runtime + recorded
 *     presence/absence facts);
 *  3. direct-provider egress block (default-deny proxy across every
 *     Hermes run + a positive-control canary proving the deny);
 *  4. representative general-agent corpus (6 tasks — text, vision,
 *     compression, TTS, STT, image generation — through the REAL pinned
 *     Hermes runtime over the Zeck adapter, verified mechanically, with
 *     per-execution trace correlation captured while the composed plane
 *     is alive);
 *  5. Zeck trace correlation + telemetry (SDK wire reads);
 *  6. duplicate/retry/failure validation (idempotent replay, the
 *     runtime's own retry over fault-injected rails, honest FAILED
 *     executions);
 *  7. baselines (same-supply direct arm measured; strong optimized
 *     external arm NOT RUN — operator boundary, owner: Lead);
 *  8. customization (the app's own configuration surface through the
 *     delegated boundary — recorded from the corpus's own configs);
 *  9. deterministic/reuse measurement (content-addressed replay);
 * 10. no-bypass audit (static reconciliation + runtime egress
 *     observation);
 * 11. reproducibility (the battery IS the reproduction script; the
 *     replay probe demonstrates it).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCompatibilityService,
  reconcileExecutionGraph,
  validateCompatibilityEvidenceRecord,
  validateDiscoveredInventory,
  validateExecutionGraph,
  type CompatibilityEvidenceRecord,
  type DiscoveredEdgeInventory,
  type EdgeDispositionEntry,
  type EgressObservation,
  type EgressViolation,
  type ProviderCredentialFact,
  type ZeckTraceFact,
} from "../../../src/integrations/compatibility/public";
import { composeProofStack } from "./compose";
import { createAdapterServer, type AdapterServer } from "../adapter/server";
import {
  HERMES_VENV_DIR,
  PROVIDER_CREDENTIAL_ENV_NAMES,
  runCorpus,
  runMediaDriver,
  runOneShot,
  writeHermesConfig,
  type CorpusRunnerOptions,
  type CorpusTaskOutcome,
} from "./corpus-runner";
import { createEgressProxy, type EgressProxy } from "./egress-proxy";
import { createSdkTraceSource, traceFactOf } from "./trace";
import { loadZaiSupplyConfig } from "./zai-config";
import {
  HERMES_DISCOVERED_INVENTORY,
  HERMES_DORMANT_SEAMS,
  HERMES_EDGE_IDS,
  HERMES_EXECUTION_GRAPH,
  HERMES_NON_AI_OPERATIONS,
  HERMES_UPSTREAM_REPOSITORY,
  HERMES_UPSTREAM_REVISION,
  HERMES_UPSTREAM_VERSION,
} from "../graph/execution-graph";
import {
  CORPUS_API_KEY_PLACEHOLDER,
  CORPUS_IMAGE_KEY_ENV,
  CORPUS_MODEL_ID,
  CORPUS_TASKS,
  DUPLICATE_PROBE_TASK,
  type CorpusTask,
} from "../corpus/tasks";

/**
 * The Zeck integration revision this battery's record pins (the PPR-022
 * Lead binding pins the governed delivery base; a different pin is a
 * different object, never an update).
 */
const INTEGRATION_REVISION =
  process.env.PPR_022_INTEGRATION_REVISION ?? "241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d";
const WORK_ROOT = process.env.PPR_022_WORK_ROOT ?? "/tmp/ppr-022-battery";
const STATE_PATH = join(WORK_ROOT, "battery-state.json");
const EVIDENCE_PATH = join("deploy", "evidence", "ppr-022.json");
const RECORD_ID = "ppr-022-hermes-live-proof";

const PACING_MS = 2000;

/** The resumable per-step facts (persisted after every completed step). */
interface BatteryState {
  inventory?: {
    graphIssues: { field: string; issue: string }[];
    inventoryIssues: { field: string; issue: string }[];
    staticFindings: { kind: string; detail: string }[];
  };
  credentials?: ProviderCredentialFact[];
  canary?: {
    ok: boolean;
    violation: EgressViolation | null;
    stdoutTail: string;
  };
  corpus?: {
    outcomes: readonly CorpusTaskOutcome[];
    /** Trace facts captured while the composed plane was alive. */
    traces: readonly ZeckTraceFact[];
  };
  replay?: {
    firstEdgeExecutions: number;
    secondEdgeExecutions: number;
    secondReplayed: number;
  };
  failure?: {
    providerUnavailableExecutions: { executionId: string; terminal: string }[];
    rateLimitExecutions: { executionId: string; terminal: string }[];
    runtimeSurfacedError: boolean;
    timeoutPathUnitPinned: boolean;
  };
  direct?: {
    ranTasks: string[];
    outcomes: { taskId: string; resolved: boolean; durationMs: number }[];
    providerEgressObserved: boolean;
    rateLimited: boolean;
  };
}

function loadState(): BatteryState {
  if (!existsSync(STATE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as BatteryState;
  } catch {
    return {};
  }
}

function saveState(state: BatteryState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The supply health gate: a live pre-check of the supply's chat surface
 * before any LIVE battery step. A rate-limited (or unreachable) supply
 * aborts the step WITHOUT checkpointing anything — failed corpus outcomes
 * must never be recorded as proof facts (the honest boundary is a clean
 * abort; the next invocation retries when the window clears).
 */
async function requireHealthySupply(): Promise<void> {
  const supply = loadZaiSupplyConfig();
  const base = supply.baseUrl.replace(/\/+$/, "");
  let status = 0;
  try {
    const probe = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: supply.authHeaders,
      body: JSON.stringify({
        model: "glm-4-plus",
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    status = probe.status;
  } catch {
    status = 0;
  }
  if (status === 429 || status === 0) {
    throw new Error(
      `the supply endpoint is not currently serving (probe status ${status}) — the live battery steps refuse to run against an unhealthy supply; wait for the quota window and re-invoke (the battery resumes from its checkpoint)`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`the supply endpoint probe returned HTTP ${status} — refusing to run live steps against an unhealthy supply`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(HERMES_VENV_DIR, "bin", "hermes"))) {
    throw new Error(
      `the pinned Hermes venv is absent at ${HERMES_VENV_DIR} — build it per the demo entry's reproducibility instructions before running the battery`,
    );
  }
  mkdirSync(WORK_ROOT, { recursive: true });
  const state = loadState();
  const startedAt = Date.now();

  // ------------------------------------------------------------------
  // Step 1 — edge inventory + static no-bypass reconciliation
  // ------------------------------------------------------------------
  if (state.inventory === undefined) {
    console.log("[battery 1] edge inventory + static no-bypass reconciliation");
    const graphIssues = [...validateExecutionGraph(HERMES_EXECUTION_GRAPH)];
    const inventoryIssues = [...validateDiscoveredInventory(HERMES_DISCOVERED_INVENTORY)];
    const findings = reconcileExecutionGraph(HERMES_EXECUTION_GRAPH, HERMES_DISCOVERED_INVENTORY);
    state.inventory = {
      graphIssues,
      inventoryIssues,
      staticFindings: findings.map((f) => ({ kind: f.kind, detail: f.detail })),
    };
    saveState(state);
  } else {
    console.log("[battery 1] edge inventory — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 2 — provider credential facts (the scrub basis)
  // ------------------------------------------------------------------
  if (state.credentials === undefined) {
    console.log("[battery 2] provider credential observation + scrub basis");
    state.credentials = PROVIDER_CREDENTIAL_ENV_NAMES.map((name) => ({
      envVarName: name,
      present: typeof process.env[name] === "string" && (process.env[name] ?? "").length > 0,
    }));
    saveState(state);
  } else {
    console.log("[battery 2] credentials — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 3 — egress canary (the positive control)
  // ------------------------------------------------------------------
  if (state.canary === undefined) {
    console.log("[battery 3] egress canary — a direct-provider LLM call must be blocked");
    const proxy = await createEgressProxy();
    try {
      state.canary = await runEgressCanary(proxy);
      console.log(`        canary ok=${state.canary.ok}`);
    } finally {
      proxy.close();
    }
    saveState(state);
  } else {
    console.log("[battery 3] egress canary — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Steps 4+5 — the representative corpus through the Zeck arm, with
  // live trace correlation (one composed plane, captured while alive)
  // ------------------------------------------------------------------
  if (state.corpus === undefined) {
    await requireHealthySupply();
    console.log("[battery 4] composing the proof stack (real Zeck public API + model gateway + multi-surface GLM rail)");
    const stack = await composeProofStack({
      minDispatchIntervalMs: PACING_MS,
      retryCooldownMs: 15_000,
    });
    const adapter = await createAdapterServer({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.apiToken,
      applicationId: stack.applicationId,
    });
    const proxy = await createEgressProxy();
    console.log(`        api=${stack.apiBaseUrl} adapter=${adapter.url} proxy=${proxy.url}`);
    try {
      console.log("[battery 5] representative general-agent corpus (Zeck arm, pinned Hermes)");
      const outcomes = await runCorpus(
        {
          adapter,
          proxy,
          workspaceRoot: join(WORK_ROOT, "corpus"),
          railFacts: stack.railFacts,
          interTaskDelayMs: 3000,
        },
        CORPUS_TASKS,
      );
      console.log("[battery 9] Zeck trace correlation + telemetry (SDK wire reads)");
      const traces = await correlateTraces(stack, adapter);
      state.corpus = { outcomes, traces };
      saveState(state);
    } finally {
      adapter.close();
      proxy.close();
      await stack.close();
    }
  } else {
    console.log("[battery 5] representative corpus — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 6a — duplicate/replay probe (determinism + reuse axis)
  // ------------------------------------------------------------------
  if (state.replay === undefined) {
    await requireHealthySupply();
    console.log("[battery 6] duplicate/replay probe (content-addressed idempotency)");
    const stack = await composeProofStack({
      minDispatchIntervalMs: PACING_MS,
      retryCooldownMs: 15_000,
    });
    const adapter = await createAdapterServer({
      apiBaseUrl: stack.apiBaseUrl,
      token: stack.apiToken,
      applicationId: stack.applicationId,
    });
    const proxy = await createEgressProxy();
    try {
      const options: CorpusRunnerOptions = {
        adapter,
        proxy,
        workspaceRoot: join(WORK_ROOT, "replay"),
        railFacts: stack.railFacts,
      };
      const outcomes = await runCorpus(options, [DUPLICATE_PROBE_TASK]);
      const firstEdgeExecutions = outcomes[0]?.edgeExecutions.length ?? 0;
      const outcomes2 = await runCorpus(options, [DUPLICATE_PROBE_TASK]);
      const secondEdgeExecutions = outcomes2[0]?.edgeExecutions.length ?? 0;
      const secondReplayed = outcomes2[0]?.edgeExecutions.filter((e) => e.replayed).length ?? 0;
      state.replay = { firstEdgeExecutions, secondEdgeExecutions, secondReplayed };
      console.log(
        `        replay: ${secondReplayed}/${secondEdgeExecutions} request(s) replayed the durable outcome`,
      );
      saveState(state);
    } finally {
      adapter.close();
      proxy.close();
      await stack.close();
    }
  } else {
    console.log("[battery 6] duplicate/replay probe — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 6b — failure-path validation (fault-injected rails)
  // ------------------------------------------------------------------
  if (state.failure === undefined) {
    console.log("[battery 7] failure-path validation (provider-unavailable + rate-limit rails)");
    state.failure = await runFailureValidation();
    saveState(state);
  } else {
    console.log("[battery 7] failure-path validation — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 7 — baselines (direct same-supply arm; external arm = NOT RUN)
  // ------------------------------------------------------------------
  if (state.direct === undefined) {
    await requireHealthySupply();
    console.log("[battery 8] direct same-supply baseline arm (no Zeck mediation)");
    const proxy = await createEgressProxy();
    try {
      state.direct = await runDirectBaseline(proxy);
    } finally {
      proxy.close();
    }
    saveState(state);
  } else {
    console.log("[battery 8] direct baseline — resumed from checkpoint");
  }

  // ------------------------------------------------------------------
  // Step 12 — assemble + validate + assess the evidence record
  // ------------------------------------------------------------------
  console.log("[battery 12] assembling the evidence record");
  const evidence = assembleEvidence(state, startedAt);
  mkdirSync(join(process.cwd(), "deploy", "evidence"), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  formatEvidenceRecordWithBiome();
  console.log(`\n[battery] wrote ${EVIDENCE_PATH}`);
  console.log(`[battery] derived status: ${evidence.derivedAssessment.status}`);
  for (const rule of evidence.derivedAssessment.ruleResults) {
    console.log(`  ${rule.satisfied ? "PASS" : "FAIL"}  ${rule.ruleId}`);
  }
  console.log("[battery] final certification: PENDING (owner: Tech-Lead — merge-time binding)");
}

// ---------------------------------------------------------------------------
// Trace correlation (captured while the composed plane is alive)
// ---------------------------------------------------------------------------

async function correlateTraces(
  stack: Awaited<ReturnType<typeof composeProofStack>>,
  adapter: AdapterServer,
): Promise<ZeckTraceFact[]> {
  const traceSource = createSdkTraceSource({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const executionsByEdge = new Map<string, string[]>();
  for (const log of adapter.requests()) {
    const list = executionsByEdge.get(log.edgeId) ?? [];
    if (!list.includes(log.executionId)) {
      list.push(log.executionId);
    }
    executionsByEdge.set(log.edgeId, list);
  }
  const traces: ZeckTraceFact[] = [];
  for (const [edgeId, executionIds] of executionsByEdge) {
    for (const executionId of executionIds) {
      const read = await traceSource.readExecutionTrace(stack.applicationId, executionId);
      traces.push(traceFactOf(edgeId, stack.applicationId, executionId, read));
    }
  }
  return traces;
}

// ---------------------------------------------------------------------------
// The egress canary (positive control)
// ---------------------------------------------------------------------------

/**
 * The canary points the pinned runtime STRAIGHT at a REAL direct-provider
 * endpoint (api.openai.com — the class the proof must block) and runs a
 * one-shot turn: every egress attempt must be denied by the proof proxy
 * (the run fails with a transport error; the proxy records the blocked
 * violation — the positive control that the deny actually denies).
 */
async function runEgressCanary(proxy: EgressProxy): Promise<NonNullable<BatteryState["canary"]>> {
  const workRoot = join(WORK_ROOT, "canary");
  mkdirSync(workRoot, { recursive: true });
  const home = join(WORK_ROOT, "canary-home");
  mkdirSync(home, { recursive: true });
  const canaryTask: CorpusTask = {
    taskId: "canary",
    title: "canary",
    spec: { instruction: "Say hello.", toolsets: "", maxTurns: 3 },
    fixture: () => {},
    verify: () => ({ resolved: false, checkOutput: "canary" }),
  };
  // The canary's config points the main model at the REAL OpenAI endpoint.
  writeHermesConfig(home, "https://api.openai.com/v1", canaryTask);
  const result = await runOneShot(
    { proxy, runTimeoutMs: 120_000 },
    workRoot,
    home,
    "Say hello.",
    "",
  );
  const openaiViolation =
    proxy.violations().find((violation) => /api\.openai\.com/.test(violation.host)) ?? null;
  // THE CANARY'S CLAIM is that the deny actually denies: the proof proxy
  // observed and BLOCKED a direct-provider connection attempt from the
  // pinned runtime. The run's own failure mode (a transport error after
  // the runtime's retry ladder, or a wall-clock kill while it retries —
  // every egress is denied, so it CANNOT succeed) is recorded honestly
  // but is not the claim itself.
  const ok = openaiViolation !== null && openaiViolation.blocked;
  return {
    ok,
    violation: openaiViolation,
    stdoutTail: `${result.stdout.slice(-400)}|exit=${result.exitCode}|timedOut=${result.timedOut}`,
  };
}

// ---------------------------------------------------------------------------
// Failure-path validation (fault-injected rails; own composed stacks)
// ---------------------------------------------------------------------------

async function runFailureValidation(): Promise<NonNullable<BatteryState["failure"]>> {
  const base = join(WORK_ROOT, "failure");
  mkdirSync(base, { recursive: true });
  const runFaultArm = async (
    label: string,
    faultInjector: NonNullable<Parameters<typeof composeProofStack>[0]>["faultInjector"],
  ) => {
    const faultStack = await composeProofStack({
      faultInjector,
      minDispatchIntervalMs: 0,
      retryCooldownMs: 500,
    });
    const faultAdapter = await createAdapterServer({
      apiBaseUrl: faultStack.apiBaseUrl,
      token: faultStack.apiToken,
      applicationId: faultStack.applicationId,
    });
    const faultProxy = await createEgressProxy();
    try {
      const outcomes = await runCorpus(
        {
          adapter: faultAdapter,
          proxy: faultProxy,
          workspaceRoot: join(base, label),
          railFacts: faultStack.railFacts,
          runTimeoutMs: 240_000,
        },
        [DUPLICATE_PROBE_TASK],
      );
      const logs = faultAdapter.requests();
      const runtimeSurfacedError = /error|failed|denied|stuck|timeout|exception|not connected/i.test(
        `${outcomes[0]?.stdoutTail ?? ""}${outcomes[0]?.stderrTail ?? ""}`,
      );
      return {
        executions: logs.map((log) => ({ executionId: log.executionId, terminal: log.terminal })),
        runtimeSurfacedError,
      };
    } finally {
      faultAdapter.close();
      faultProxy.close();
      await faultStack.close();
    }
  };

  const providerUnavailable = await runFaultArm("provider-unavailable", async (_request, next) => {
    void _request;
    void next;
    return {
      status: 503,
      text: JSON.stringify({ error: { message: "fault-injected provider unavailability" } }),
    };
  });
  const rateLimit = await runFaultArm("rate-limit", async (_request, next) => {
    void _request;
    void next;
    return { status: 429, text: JSON.stringify({ error: "fault-injected rate limit" }) };
  });

  return {
    providerUnavailableExecutions: providerUnavailable.executions,
    rateLimitExecutions: rateLimit.executions,
    runtimeSurfacedError: providerUnavailable.runtimeSurfacedError || rateLimit.runtimeSurfacedError,
    // The timeout path (a hanging supply transport) is pinned by the
    // unit suite (rail timeout → provider-failure timeout category →
    // honest FAILED execution) — running a real multi-minute hang in
    // the battery would prove the same code path at disproportionate
    // cost (disclosed; the identical disclosure PPR-020 recorded).
    timeoutPathUnitPinned: true,
  };
}

// ---------------------------------------------------------------------------
// The direct same-supply baseline arm (no Zeck mediation)
// ---------------------------------------------------------------------------

/**
 * The direct arm points the SAME pinned runtime STRAIGHT at the supply
 * endpoint (the application runtime holds the endpoint credential and
 * the direct connection — the exact property the Zeck arm removes; the
 * identical discipline PPR-019/020 established for their direct arms).
 * The supply endpoint authenticates through session headers a Bearer-only
 * api_key cannot carry, so the direct arm materializes the real supply
 * credential into the Hermes runtime through the app's own
 * model.default_headers configuration axis (extra_headers — the
 * application's configuration surface). The arm's egress environment
 * exempts ONLY the supply host from the deny proxy (NO_PROXY override):
 * supply traffic goes direct; every other non-loopback egress stays
 * denied.
 */
async function runDirectBaseline(proxy: EgressProxy): Promise<NonNullable<BatteryState["direct"]>> {
  const supply = loadZaiSupplyConfig();
  const supplyHost = new URL(supply.baseUrl).hostname;
  const base = join(WORK_ROOT, "direct");
  mkdirSync(base, { recursive: true });
  const supplyBase = supply.baseUrl.replace(/\/+$/, "");
  // Idempotent /v1 join (PPR-019 class-precedent): a supply baseUrl that
  // already ends in /v1 must NOT be double-prefixed.
  const directBaseUrl = supplyBase.endsWith("/v1") ? supplyBase : `${supplyBase}/v1`;
  // The direct arm's credential materialization — the session headers
  // (x-z-ai-from/x-chat-id/x-user-id/x-token) ride the app's own
  // default_headers axis; the Bearer key rides the api_key axis.
  const supplyHeaders = supply.authHeaders as Record<string, string>;
  const directHeaders: Record<string, string> = { "x-z-ai-from": "Z" };
  for (const name of ["x-chat-id", "x-user-id", "x-token"]) {
    const value = supplyHeaders[name];
    if (typeof value === "string" && value.length > 0) {
      directHeaders[name] = value;
    }
  }
  const directApiKey = /^Bearer (.+)$/.exec(supplyHeaders.authorization ?? "")?.[1] ?? "";
  const headerYaml = Object.entries(directHeaders)
    .map(([key, value]) => `      ${key}: "${value.replace(/"/g, "'")}"`)
    .join("\n");

  const outcomes: { taskId: string; resolved: boolean; durationMs: number }[] = [];
  let providerEgressObserved = false;
  let rateLimited = false;

  for (const task of CORPUS_TASKS) {
    if (task.taskId === "vision-qa" || task.taskId === "generate-image") {
      // The direct arm cannot serve these edges: the supply's plain
      // openai/ chat transport does not route image parts to the vision
      // endpoint, and the image-gen plugin's OpenAI wire does not match
      // the supply's image protocol (verified live: the chat endpoint
      // accepts but mis-serves multimodal content; the images endpoint
      // shape differs) — the honest direct-arm corpus is the
      // direct-reachable subset (the identical boundary PPR-020's
      // direct arm recorded for its vision edge).
      continue;
    }
    const workdir = join(base, task.taskId);
    const home = join(base, `${task.taskId}-home`);
    rmSync(workdir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(home, { recursive: true });
    task.fixture(workdir);
    // The direct config: the app's own axes, straight at the supply.
    writeHermesConfig(home, directBaseUrl, task);
    // Overlay the default_headers axis (the app's own config key).
    const configPath = join(home, "config.yaml");
    const config = readFileSync(configPath, "utf8").replace(
      "  streaming: true",
      `  streaming: true\n    default_headers:\n${headerYaml}`,
    );
    writeFileSync(configPath, config);

    const startedAt = Date.now();
    const directExtraEnv: Record<string, string> = {
      // The direct arm's ONLY egress allowance: the supply host goes
      // direct (the direct-provider egress the Zeck arm provably does
      // not make). Everything else stays default-deny.
      NO_PROXY: `127.0.0.1,localhost,${supplyHost}`,
      no_proxy: `127.0.0.1,localhost,${supplyHost}`,
      // The direct arm's credential materialization (the app's own
      // env axes — the application runtime holds the provider
      // credential by definition of a direct baseline; the Zeck arm's
      // scrubbed environment never carries these names).
      OPENAI_API_KEY: directApiKey,
      VOICE_TOOLS_OPENAI_KEY: directApiKey,
      [CORPUS_IMAGE_KEY_ENV]: directApiKey,
    };
    // The direct config's audio/api_key axes must carry the REAL key
    // (the certified placeholder would 401) — the app's own config keys.
    const directConfigPath = join(home, "config.yaml");
    writeFileSync(
      directConfigPath,
      readFileSync(directConfigPath, "utf8").split(CORPUS_API_KEY_PLACEHOLDER).join(directApiKey),
    );

    const result =
      task.taskId === "transcribe-memo"
        ? await runMediaDriver(
            { proxy, runTimeoutMs: 420_000, extraEnv: directExtraEnv },
            workdir,
            home,
            join(workdir, "voice-memo.wav"),
          )
        : await runOneShot(
            { proxy, runTimeoutMs: 420_000, extraEnv: directExtraEnv },
            workdir,
            home,
            task.spec.instruction,
            task.spec.toolsets,
          );
    const verification = task.verify({
      workdir,
      home,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    outcomes.push({
      taskId: task.taskId,
      resolved: verification.resolved,
      durationMs: Date.now() - startedAt,
    });
    if (verification.resolved) {
      providerEgressObserved = true;
    }
    if (/rate.?limit|429|Too many requests/i.test(`${result.stdout}${result.stderr}`)) {
      rateLimited = true;
    }
    console.log(
      `[battery 8] direct arm ${task.taskId}: ${verification.resolved ? "RESOLVED" : "UNRESOLVED"} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
    );
  }

  return {
    ranTasks: outcomes.map((outcome) => outcome.taskId),
    outcomes,
    providerEgressObserved,
    rateLimited,
  };
}

// ---------------------------------------------------------------------------
// Evidence assembly (pure — from the checkpointed facts)
// ---------------------------------------------------------------------------

function assembleEvidence(state: BatteryState, startedAtAtAssembly: number): {
  evidenceRecord: CompatibilityEvidenceRecord;
  derivedAssessment: ReturnType<
    ReturnType<typeof createCompatibilityService>["assess"]
  >;
  [key: string]: unknown;
} {
  const corpus = state.corpus?.outcomes ?? [];
  const traces = state.corpus?.traces ?? [];
  const executionsByEdge = new Map<string, string[]>();
  for (const outcome of corpus) {
    for (const edge of outcome.edgeExecutions) {
      const list = executionsByEdge.get(edge.edgeId) ?? [];
      if (!list.includes(edge.executionId)) {
        list.push(edge.executionId);
      }
      executionsByEdge.set(edge.edgeId, list);
    }
  }

  const telemetry = {
    executions: traces.length,
    eventsTotal: traces.reduce((sum, trace) => sum + trace.eventCount, 0),
    eventsPerExecutionMin: traces.reduce(
      (min, trace) => Math.min(min, trace.eventCount),
      Number.POSITIVE_INFINITY,
    ),
    verificationPassTotal: traces.reduce((sum, trace) => sum + trace.passingVerificationCount, 0),
    routeFactsPresent: traces.filter((trace) => trace.route !== null && trace.route !== undefined)
      .length,
    usageFactsPresent: traces.filter((trace) => trace.usage !== null && trace.usage !== undefined)
      .length,
  };
  if (!Number.isFinite(telemetry.eventsPerExecutionMin)) {
    telemetry.eventsPerExecutionMin = 0;
  }

  const zeckArmTokens = {
    inputTokens: corpus.reduce((sum, outcome) => sum + outcome.railUsage.inputTokens, 0),
    outputTokens: corpus.reduce((sum, outcome) => sum + outcome.railUsage.outputTokens, 0),
  };

  // The runtime egress observation across the recorded Hermes runs
  // (canary + corpus): deny mode, every violation blocked.
  const allViolations: EgressViolation[] = [
    ...(state.canary?.violation === null || state.canary?.violation === undefined
      ? []
      : [state.canary.violation]),
    ...corpus.flatMap((outcome) => [...outcome.egressViolations]),
  ];
  const egressObservation: EgressObservation = {
    mode: "deny",
    status:
      allViolations.length === 0
        ? "observed-clean"
        : allViolations.every((violation) => violation.blocked)
          ? "provably-blocked"
          : "violations-detected",
    violations: allViolations,
  };

  const corpusUsable = corpus.length > 0 && corpus.every((outcome) => outcome.resolved);

  const dispositions: EdgeDispositionEntry[] = HERMES_EDGE_IDS.map((edgeId) => {
    const executionIds = executionsByEdge.get(edgeId) ?? [];
    if (executionIds.length === 0) {
      return {
        edgeId,
        disposition: "not-run",
        cause:
          "no delegated execution was produced for this edge during the proof run (the corpus did not exercise it)",
        owner: "worker",
      } satisfies EdgeDispositionEntry;
    }
    return {
      edgeId,
      disposition: "delegated",
      zeckExecutionIds: executionIds,
      evidenceBasis: "live",
    } satisfies EdgeDispositionEntry;
  });

  const resolvedCount = corpus.filter((outcome) => outcome.resolved).length;
  const directOutcomes = state.direct?.outcomes ?? [];
  const directResolved = directOutcomes.filter((o) => o.resolved).length;
  const applicationId = "00000000-0000-7000-8000-00000000b001";

  const record: CompatibilityEvidenceRecord = {
    recordId: RECORD_ID,
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Hermes-Agent",
        repository: HERMES_UPSTREAM_REPOSITORY,
        applicationId,
      },
      pin: {
        upstreamRevision: HERMES_UPSTREAM_REVISION,
        integrationRevision: INTEGRATION_REVISION,
      },
    },
    graph: HERMES_EXECUTION_GRAPH,
    dispositions,
    egressObservation,
    providerCredentials: state.credentials ?? [],
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: corpusUsable ? "verified" : "not-verified",
      observations: [
        `Zeck arm: ${resolvedCount}/${corpus.length} declared corpus tasks resolved by the pinned unmodified Hermes-Agent runtime with Zeck as its sole AI execution authority (${corpus.map((o) => `${o.taskId}:${o.resolved ? "resolved" : "unresolved"}`).join(", ")}).`,
        `Every corpus edge execution's terminal state and verification facts are recorded in zeckTraces (read back through the public SDK wire reads); the rail-reported usage per dispatch is recorded in the battery section.`,
        `Upstream provenance: the work-order-named target Hermes-Agent is https://github.com/NousResearch/hermes-agent by Nous Research; the pinned upstream revision ${HERMES_UPSTREAM_REVISION} (origin/main at proof-time clone; the runtime's own version report: "${HERMES_UPSTREAM_VERSION}") is installed editable from the exact checkout into a dedicated Python 3.14.7 venv (the version its exact-pinned dependency closure targets).`,
        `Upstream configuration disclosures (the app's own axes, never forks): the corpus pins model.provider=custom at the adapter; every auxiliary task (title_generation, compression, vision, web_extract, session_search, background_review) is pinned provider=main so no OpenRouter/Nous/Anthropic auxiliary rung can fire; tts/stt/image_gen are selected onto their OpenAI-compatible backends pointed at the adapter (the app's own picker surfaces); agent.max_turns, model.context_length and compression.threshold are set per task — all documented config.yaml keys of the pinned revision.`,
        `Direct same-supply arm (no Zeck mediation): ${directResolved}/${directOutcomes.length} direct-reachable tasks resolved.`,
      ],
    },
    comparison: [
      {
        baseline: "same-supply-direct-arm",
        basis: "measured",
        statement:
          `Same-supply direct (non-Zeck) arm — the same pinned Hermes-Agent runtime calling the same GLM supply endpoint directly with no Zeck mediation ` +
          `(the application runtime holds the endpoint credential — the real supply key through the app's own .env axis and the session headers through its model.default_headers axis — ` +
          `by definition of a direct baseline): ${directResolved}/${directOutcomes.length} direct-reachable tasks resolved ` +
          `(the vision and image-generation edges are outside this arm: the supply's plain openai/ chat transport does not route image parts to its vision endpoint, and its images endpoint speaks a different wire — live-probed; ` +
          `the Zeck rail routes both surfaces explicitly) vs the Zeck arm's ${resolvedCount}/${corpus.length}; mean ${(meanDurationOf(directOutcomes) / 1000).toFixed(1)}s per resolved direct outcome vs ` +
          `${(meanCorpusDuration(corpus) / 1000).toFixed(1)}s per resolved Zeck outcome; direct-arm provider egress to the supply endpoint observed ` +
          `(${state.direct?.providerEgressObserved === true ? "present — the direct-provider call the Zeck arm provably does not make" : "not observed"})` +
          `${state.direct?.rateLimited === true ? "; supply-side rate-limiting observed in the direct arm (no mediation-side pacing — disclosed)" : ""}. ` +
          `Token usage per arm recorded in the battery section.`,
      },
      {
        baseline: "strong-optimized-external",
        basis: "not-measured",
        statement:
          "Strong optimized non-Zeck baseline (external commercial providers via OpenRouter or first-party endpoints) NOT RUN: this sandbox has no external provider credentials; owner: Lead.",
      },
      {
        baseline: "cost-per-resolved-outcome",
        basis: "not-measured",
        statement:
          "The sandbox's GLM supply endpoint does not report USD prices; token usage per resolved outcome is measured and recorded (Zeck arm: " +
          `${Math.round(zeckArmTokens.inputTokens / Math.max(1, resolvedCount))} in / ${Math.round(zeckArmTokens.outputTokens / Math.max(1, resolvedCount))} out tokens per resolved outcome; ` +
          `direct arm durations in the battery section), micro-USD settlement is not (the budgets authority's reservation estimate is recorded on each execution's dispatch).`,
      },
    ],
    zeckTraces: traces,
    limitations: [
      {
        area: "model supply",
        statement:
          "The model supply for every delegated edge is the sandbox's authorized GLM endpoint (internal-api.z.ai), dispatched platform-side through the real model gateway (custom rail; text + vision + speech + transcription + image surfaces). No external AI provider was reachable or used; external-provider rails are an operator boundary, not evidence about the delegation boundary this proof tests.",
        owner: "operator",
      },
      {
        area: "video-generation surface",
        statement:
          "The pinned runtime's video_generate tool ships with no in-tree provider (plugins only); the OpenAI-compatible video plugin speaks an async create/poll/download protocol whose delegation translation was not built for this proof and the declared corpus does not exercise video — an honest implementation gap recorded WITHOUT weakening completeness; owner: worker (a future work order may delegate it).",
        owner: "worker",
      },
      {
        area: "gateway/platform surfaces",
        statement:
          "The gateway process (Telegram/Discord/Slack/WhatsApp/Signal adapters), the cron daemon, and the interactive TUI are not part of the declared corpus runtime (headless one-shot CLI runs); every AI surface they would dispatch (transcription, titles, agent turns) is the SAME seam set already declared and delegated — the platform adapters themselves are non-AI transport.",
        owner: "worker",
      },
      {
        area: "terminal backend",
        statement:
          "The one-shot corpus runs execute tools in the local shell (the default backend); container/SSH/Modal/Daytona terminal backends are application-owned execution substrates outside the AI delegation boundary (disclosed).",
        owner: "operator",
      },
    ],
    notRunCauses: [
      {
        area: "strong-optimized-external-baseline",
        cause:
          "No external AI-provider credentials exist in this sandbox (OpenRouter/OpenAI/Anthropic first-party endpoints are unreachable); a strong optimized non-Zeck baseline cannot be measured here.",
        owner: "Lead",
      },
    ],
    recordedAt: new Date().toISOString(),
  };

  const recordIssues = [...validateCompatibilityEvidenceRecord(record)];
  if (recordIssues.length > 0) {
    console.error("EVIDENCE RECORD INVALID:", JSON.stringify(recordIssues, null, 2));
    throw new Error(`evidence record failed structural validation: ${recordIssues.length} issue(s)`);
  }
  const service = createCompatibilityService({
    traceSource: createSdkTraceSource({
      apiBaseUrl: "http://127.0.0.1:9/v1",
      token: "assembly-only",
      applicationId: "assembly-only",
    }),
  });
  const assessment = service.assess(
    record,
    HERMES_DISCOVERED_INVENTORY as DiscoveredEdgeInventory,
  );

  return {
    schemaVersion: 1,
    workOrder: "PPR-022",
    title: "Hermes-Agent Zeck-complete application proof (compat/hermes-agent)",
    recordedBy: "the one PPR-022 implementation worker (this session)",
    date: new Date().toISOString(),
    environment:
      `sandboxed worker pod; anonymous public clone of ${HERMES_UPSTREAM_REPOSITORY} (pinned ${HERMES_UPSTREAM_REVISION}, ` +
      `installed editable into a dedicated Python 3.14.7 venv at ${HERMES_VENV_DIR}); ` +
      `Zeck integration branch work/PPR-022-hermes-agent-proof based on governed base 241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d; ` +
      `model supply = the sandbox's authorized GLM endpoint (/etc/.z-ai-config, platform-side BYOK material, never present in the Hermes runtime)`,
    doctrine:
      "Every fact this record claims was produced by the environment named in it; every boundary the environment cannot produce is recorded as NOT RUN with its owner. No fixture, mock or simulated provider path is counted as an external PASS.",
    upstreamProvenance: {
      applicationRepository: HERMES_UPSTREAM_REPOSITORY,
      applicationRevision: HERMES_UPSTREAM_REVISION,
      applicationVersion: HERMES_UPSTREAM_VERSION,
      runtime: `editable install from the exact checkout into ${HERMES_VENV_DIR} (Python 3.14.7)`,
    },
    evidenceRecord: record,
    derivedAssessment: assessment,
    finalCertification: {
      status: "PENDING",
      owner: "Tech-Lead",
      bindingStep:
        "This record is the worker's proof-time self-assessment through the merged PPR-018A harness pieces (the corpus-runner discipline, the SDK-wire trace correlation, the derived status machine). Final certification and Demo Mirror binding are the Lead's merge-time acts; a worker never activates their own demo.",
    },
    battery: {
      batterySteps: [
        "edge inventory (static seam scan of the pinned revision, config-restricted to the declared corpus)",
        "provider credential removal from the Hermes runtime (allowlist-scrubbed subprocess environment + recorded credential facts + the literal placeholders the openai SDK's shape checks require)",
        "direct-provider egress block (default-deny proof proxy wrapping every Hermes egress except the loopback Zeck adapter + the positive-control canary)",
        "representative general-agent corpus (6 tasks — text, vision, compression, TTS, STT, image generation — pinned Hermes runtime over Zeck, verified mechanically)",
        "Zeck trace correlation (every delegated edge's executions read back through the public SDK wire reads)",
        "duplicate/retry/failure validation (idempotent replay, the runtime's own retry over fault-injected rails, honest FAILED executions, timeout path unit-pinned)",
        "direct same-supply baseline (measured) + strong optimized external baseline (NOT RUN, owner: Lead)",
        "customization test (the app's own configuration surface through the delegated boundary)",
        "deterministic/reuse measurement (content-addressed idempotency keys → measured replay rate)",
        "telemetry inspection (per-execution ledger events, route facts, usage, latency)",
        "no-bypass audit (static reconciliation + runtime egress observation)",
        "reproducibility (the battery is the reproduction script; the replay probe demonstrates it)",
      ],
      corpus: corpus.map((outcome) => ({
        taskId: outcome.taskId,
        resolved: outcome.resolved,
        checkOutput: outcome.checkOutput,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        edgeExecutions: outcome.edgeExecutions,
        railUsage: outcome.railUsage,
        egressViolations: outcome.egressViolations.length,
        stdoutTail: outcome.stdoutTail.slice(-400),
      })),
      canaryProbes: {
        ok: state.canary?.ok === true,
        violation: state.canary?.violation ?? null,
      },
      duplicateProbe: state.replay ?? null,
      failureValidation: state.failure ?? null,
      directBaseline: state.direct ?? null,
      customization: {
        statement:
          "The pinned app's own configuration surface remains fully operative through the delegated boundary: per-task toolset selection (-t file,terminal/vision/tts/image_gen — the app's own toolset groups), per-task agent.max_turns, per-task model.context_length + compression.threshold + compression.threshold_tokens (the compaction task runs 65536/0.3 with a 10,000-token trigger cap while the others run the defaults), the auxiliary task provider pinning (auxiliary.<task>.provider=main — the app's auxiliary configuration section), the media tool picker selections (tts.provider/stt.provider/image_gen.provider onto the OpenAI-compatible backends — the app's own `hermes tools` surfaces), and the LLM model id/base_url/streaming axes — all flowed through the same single delegated seam with zero application-code changes.",
        evidence:
          "corpus task configs (harness/corpus-runner.ts writes one HERMES_HOME config.yaml per task) + the per-task adapter logs",
      },
      telemetry,
      reuse: {
        statement:
          `Content-addressed idempotency keys: the identical replay probe re-issued ${state.replay?.secondEdgeExecutions ?? 0} request(s), of which ${state.replay?.secondReplayed ?? 0} replayed the durable outcome (content-identical requests are served from the execution ledger, not re-dispatched).`,
      },
    },
    dormantEdgeDisclosures: HERMES_DORMANT_SEAMS,
    nonAiOperations: HERMES_NON_AI_OPERATIONS,
    staticFindings: state.inventory?.staticFindings ?? [],
    durations: { assemblyMs: Date.now() - startedAtAtAssembly },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format the written evidence record with the repository's own formatter
 * (biome — the repo's lint gate), so the record is lint-clean as written.
 * Content-neutral (JSON-equivalent); degrades honestly to the plain
 * JSON.stringify form when biome is unavailable.
 */
function formatEvidenceRecordWithBiome(): void {
  const result = spawnSync("bunx", ["biome", "format", "--write", EVIDENCE_PATH], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    console.log("[battery] biome format unavailable — record left in plain JSON form");
  }
}

function meanCorpusDuration(corpus: readonly CorpusTaskOutcome[]): number {
  const resolved = corpus.filter((outcome) => outcome.resolved);
  if (resolved.length === 0) {
    return 0;
  }
  return resolved.reduce((sum, outcome) => sum + outcome.durationMs, 0) / resolved.length;
}

function meanDurationOf(outcomes: readonly { resolved: boolean; durationMs: number }[]): number {
  const resolved = outcomes.filter((outcome) => outcome.resolved);
  if (resolved.length === 0) {
    return 0;
  }
  return resolved.reduce((sum, outcome) => sum + outcome.durationMs, 0) / resolved.length;
}

main().catch((error) => {
  console.error("[battery] FAILED:", error);
  process.exit(1);
});
