/**
 * The PPR-023 corpus runner — drives the REAL pinned OpenClaw runtime
 * (openclaw at the exact upstream git revision f6883b37, built from the
 * exact checkout in this sandbox) through the Zeck adapter inside the
 * proof environment (egress-deny proxy + credential-scrubbed allowlist
 * environment + the app's own --config configuration surface pointed at
 * the adapter), verifies each task mechanically, and records the
 * per-task facts (edge executions, egress violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, ACR-007 §5): the subprocess
 * environment is BUILT FROM AN ALLOWLIST — no provider credential can
 * leak in by construction (the same discipline PPR-018/019/020/022
 * established). The only credential-shaped values present are the
 * literal placeholder `zeck-local-adapter` (the OpenAI-compatible
 * clients refuse to build without a non-empty key — the value
 * authenticates nothing: the adapter ignores it and no provider host is
 * reachable from the runtime, whose every non-loopback egress is denied
 * by the proof proxy).
 *
 * THE CERTIFIED CONFIG (the app's own surface, zero code changes):
 * a pinned openclaw.json5 carrying
 *   - models.providers.zeck  — the custom OpenAI-completions provider
 *     (baseUrl: the adapter) for the main agent model (glm-4-plus) and
 *     the native-vision-capable entry (glm-4.5v);
 *   - models.providers.openai — the OpenAI-compatible override entry
 *     (baseUrl: the adapter) the image/audio/TTS surfaces resolve
 *     through (mediaModels.image / tools.media audio / tts openai);
 *   - agents.defaults.model.primary = zeck/glm-4-plus;
 *   - tools.media.models[] — the image-capable (openai/glm-4.5v) and
 *     audio-capable (openai/glm-asr) entries;
 *   - tts.providers.openai — the speech provider pointed at the adapter;
 *   - browser.executablePath — the sandbox's Chromium (the browser task)
 *     + the documented private-endpoint opt-in for the loopback adapter.
 * `openclaw agent exec --config <path> --cwd <dir>` and `openclaw infer
 * ... --config <path>` read exactly this file and nothing ambient.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import {
  CORPUS_API_KEY_PLACEHOLDER,
  CORPUS_AUDIO_MODEL,
  CORPUS_IMAGE_DESCRIBE_MODEL,
  CORPUS_IMAGE_GEN_MODEL,
  CORPUS_MAIN_MODEL,
  CORPUS_TTS_MODEL,
  type CorpusTask,
} from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import { createLoopbackTokenPage, type LoopbackTokenPage } from "./fixture-page";
import type { RailExecutionFact } from "./compose";

/**
 * Where the pinned OpenClaw source lives (the exact checkout; the
 * runtime executes the checkout's COMPILED form — every .ts under
 * src/ and packages/<p>/src/ transformed to an in-place .js sibling
 * plus package dist/*.mjs mirrors by the harness's committed builder
 * (build-compiled-runtime.ts; digest manifest at the checkout root,
 * byte-identity re-verifiable). The pinned revision's own version
 * report is unchanged: "OpenClaw 2026.9.7 (f6883b3)".
 *
 * WHY COMPILED (measured + disclosed): the source-run path
 * (`node --import scripts/tsx.mjs src/entry.ts`) transpiles the full
 * app graph in EVERY runtime process — the respawned CLI child AND
 * every Worker thread (the pinned revision loads `tsx/esm` into each
 * .ts worker). Worker isolates do NOT inherit NODE_OPTIONS heap
 * caps, so a --max-old-space-size ceiling cannot contain them:
 * measured live, the respawned CLI child carrying the cap still
 * accumulated 30–44 threads, up to 8 esbuild services and a 2.7GB+
 * RSS until the pod's kernel OOM-killer SIGKILLed it (dmesg: five
 * consecutive kills at anon-rss 2.7–2.9GB), while the bundled-plugin
 * capture tree concurrently filled the disk (ENOSPC). The app's own
 * tsdown bundle build also refuses on this machine (its preflight
 * measured 4352MB needed vs 2035MB available). The compiled tree is
 * the SAME enablement class the process-ownership pair established
 * (compiled artifacts of the pinned sources beside them), applied to
 * the whole runtime — and it is exactly the pinned revision's own
 * deploy-build semantics (its runtimeNeedsTypeScriptLoader() selects
 * plain node for .js entries; its WORKER_DEPLOY_BUILD anchor does
 * precisely this), so the app's own process-owner admission then
 * passes by design (a real .js module, no loader children).
 */
export const OPENCLAW_CHECKOUT_DIR = "/home/z/openclaw-upstream" as const;

/** The command prefix that runs the compiled pinned OpenClaw runtime. */
export const OPENCLAW_RUN_PREFIX: readonly string[] = [
  join(OPENCLAW_CHECKOUT_DIR, "src", "entry.js"),
];

/** The harness root (this file's directory). */
const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The loader-redirect preload (retained for the record; the compiled
 * tree supersedes it — no .ts URL ever resolves in the certified run,
 * so the redirect is inert and the certified env no longer sets it). */
export const OPENCLAW_RUNTIME_PRELOAD = join(HARNESS_ROOT, "runtime-preload.mjs");

/**
 * The compiled process-ownership artifacts the compiled tree serves
 * (in-place .js transforms of the pinned .ts pair — the same files the
 * whole-tree builder produces for every source; listed separately so
 * the battery can call them out explicitly).
 */
export const OPENCLAW_COMPILED_ARTIFACTS: readonly string[] = [
  join(OPENCLAW_CHECKOUT_DIR, "compiled-runtime.manifest.json"),
  join(OPENCLAW_CHECKOUT_DIR, "src", "entry.js"),
  join(OPENCLAW_CHECKOUT_DIR, "src", "process", "supervisor", "linux-child-subreaper.js"),
  join(
    OPENCLAW_CHECKOUT_DIR,
    "src",
    "process",
    "supervisor",
    "service-child-group-anchor.js",
  ),
];

/**
 * The provider-credential env-var NAMES the battery records facts for
 * (the application's own credential surface at the pinned revision —
 * the harness's reusable list plus OpenClaw's own provider names from
 * docs/reference/api-usage-costs.md + the provider plugin catalog).
 */
export const PROVIDER_CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
  "XAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_SPEECH_KEY",
  "GITHUB_COPILOT_TOKEN",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "NVIDIA_API_KEY",
  "XIAOMI_API_KEY",
  "ARCEEAI_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_HOST",
  "DEEPINFRA_API_KEY",
  "KILOCODE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "LM_API_KEY",
  "FAL_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "ELEVENLABS_API_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "PARALLEL_API_KEY",
  "SEARXNG_BASE_URL",
  "FISH_API_KEY",
  "VOLCANO_ENGINE_API_KEY",
  "BYTEPLUS_API_KEY",
  "ALIBABA_API_KEY",
  "DASHSCOPE_API_KEY",
  "VOYAGE_API_KEY",
  "DEEPGRAM_API_KEY",
  "SENSEAUDIO_API_KEY",
  "GRADIUM_API_KEY",
  "INWORLD_API_KEY",
  "CEREBRAS_API_KEY",
  "FIREWORKS_API_KEY",
  "CHUTES_API_KEY",
  "NOVITA_API_KEY",
  "BASETEN_API_KEY",
  "RUNWAY_API_KEY",
  "PIXVERSE_API_KEY",
  "KIE_API_KEY",
] as const;

/** One corpus task's run outcome (the battery's runtime evidence). */
export interface CorpusTaskOutcome {
  readonly taskId: string;
  readonly title: string;
  readonly resolved: boolean;
  readonly checkOutput: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly timedOut: boolean;
  readonly edgeExecutions: readonly {
    readonly edgeId: string;
    readonly executionId: string;
    readonly replayed: boolean;
  }[];
  readonly egressViolations: readonly EgressViolation[];
  readonly railUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly dispatches: number;
    readonly failures: number;
  };
  /** The honest NOT-RUN cause when the task could not execute. */
  readonly unavailable: {
    readonly outcome: "NOT-RUN";
    readonly cause: string;
    readonly owner: string;
  } | null;
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly workspaceRoot: string;
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** Optional pre-task guard: a throw aborts the run BEFORE the task. */
  readonly preTaskGuard?: () => Promise<void>;
  /** Optional per-task checkpoint hook (fires only after unambiguous completion). */
  readonly onTaskComplete?: (outcome: CorpusTaskOutcome) => void;
  /** The browser binary for the browser task (Playwright Chromium in this sandbox). */
  readonly browserExecutablePath?: string;
}

function tailOf(text: string, maxChars = 1600): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/**
 * Write the certified runtime's openclaw.json5 — the app's OWN
 * configuration surface (every axis is a documented OpenClaw config key;
 * zero code changes): the custom provider endpoint for the main model,
 * the OpenAI-compatible override the media surfaces resolve through, the
 * media-understanding entries, the TTS provider, and the browser binary.
 */
export function writeOpenClawConfig(
  configPath: string,
  adapterUrl: string,
  browserExecutablePath: string | undefined,
): void {
  const config = {
    // The custom OpenAI-completions provider (the main agent model +
    // native-vision entry). "api: openai-completions" pins the wire
    // protocol: POST {base}/chat/completions.
    models: {
      mode: "merge",
      providers: {
        zeck: {
          baseUrl: `${adapterUrl}/v1`,
          apiKey: CORPUS_API_KEY_PLACEHOLDER,
          api: "openai-completions",
          models: [
            {
              id: CORPUS_MAIN_MODEL,
              name: "GLM 4 Plus (delegated)",
              input: ["text", "image"],
            },
            {
              id: CORPUS_IMAGE_DESCRIBE_MODEL,
              name: "GLM 4.5V (delegated)",
              input: ["text", "image"],
            },
          ],
        },
        // The OpenAI-compatible override the image/audio/TTS surfaces
        // resolve through (image generation's models.providers.openai
        // baseUrl; the audio transcription context.baseUrl; TTS's own
        // provider block below carries the same adapter).
        openai: {
          baseUrl: `${adapterUrl}/v1`,
          apiKey: CORPUS_API_KEY_PLACEHOLDER,
          api: "openai-completions",
          models: [
            { id: CORPUS_IMAGE_DESCRIBE_MODEL, name: "GLM 4.5V (delegated)" },
            { id: CORPUS_AUDIO_MODEL, name: "GLM ASR (delegated)" },
            { id: CORPUS_IMAGE_GEN_MODEL, name: "GLM Image (delegated)" },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: `zeck/${CORPUS_MAIN_MODEL}` },
        mediaModels: {
          image: { primary: `openai/${CORPUS_IMAGE_GEN_MODEL}` },
        },
      },
    },
    tools: {
      media: {
        models: [
          {
            provider: "openai",
            model: CORPUS_IMAGE_DESCRIBE_MODEL,
            capabilities: ["image"],
          },
          {
            provider: "openai",
            model: CORPUS_AUDIO_MODEL,
            capabilities: ["audio"],
          },
        ],
        image: { preferredModel: `openai/${CORPUS_IMAGE_DESCRIBE_MODEL}` },
        audio: { enabled: true },
      },
    },
    tts: {
      provider: "openai",
      providers: {
        openai: {
          apiKey: CORPUS_API_KEY_PLACEHOLDER,
          baseUrl: `${adapterUrl}/v1`,
          model: CORPUS_TTS_MODEL,
          speakerVoice: "tongtong",
          responseFormat: "wav",
        },
      },
    },
    // The documented loopback-image-endpoint opt-in (the adapter is a
    // private/loopback endpoint; the app's own docs name this axis for
    // exactly this case) + the browser binary for the browser task.
    ...(browserExecutablePath === undefined
      ? {}
      : {
          browser: {
            executablePath: browserExecutablePath,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
          },
        }),
  };
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Build the scrubbed subprocess environment (allowlist only). */
export function scrubbedOpenClawEnv(options: {
  readonly proxyUrl: string;
  readonly home: string;
  readonly stateDir: string;
  readonly configPath: string;
}): Record<string, string> {
  return {
    PATH: `${join(OPENCLAW_CHECKOUT_DIR, "node_modules", ".bin")}:/usr/local/bin:/usr/bin:/bin`,
    HOME: options.home,
    OPENCLAW_STATE_DIR: options.stateDir,
    // The global config pin (the documented env axis) — every command
    // (agent exec + the infer capability surfaces) reads exactly this
    // file; the per-command --config flag of `agent exec` names the same
    // file (belt and braces, never a second source of truth).
    OPENCLAW_CONFIG_PATH: options.configPath,
    // THE PROCESS-OWNERSHIP LOADER REDIRECT (the enablement the header
    // documents): every pinned-runtime node process — the top command AND
    // every subprocess that inherits this environment, including the
    // exec-tool supervisor's detached anchor, whose spawn argv the app
    // itself composes as `node --import tsx <anchor.ts>` — loads the
    // harness preload FIRST, so the redirect hook (registered ahead of
    // tsx's own, executed after it in the chain's LIFO order) swaps the
    // resolved process-ownership module URLs for their compiled forms.
    // Measured live before any certified run: ENTRY-REDIRECT-OK (subreaper
    // admitted, command executed, descendantsReaped, clean close) and the
    // compiled subreaper byte-identical to a fresh esbuild transform of
    // the pinned .ts.
    // NODE_OPTIONS carries the V8 old-space ceiling — the identical
    // axis the app's own CI pins for its runs (scripts/prepush-ci.sh
    // sets NODE_OPTIONS=--max-old-space-size=6144; docs/gateway/
    // troubleshooting/gateway-service-and-process.md documents the
    // axis). The compiled runtime needs no TypeScript loader (and no
    // loader redirect: every entry the app resolves is its compiled
    // form, so its own runtimeNeedsTypeScriptLoader() selects plain
    // node); the cap keeps the main isolate inside this 4GB pod's
    // budget alongside everything else the sandbox runs.
    NODE_OPTIONS: "--max-old-space-size=1600",
    // The app's own documented env axis (src/plugins/bundled-dir.ts:
    // areBundledPluginsDisabled — the identical axis the repo's own
    // CI/tests set): disable bundled-plugin discovery. In a source
    // checkout, discovery CAPTURES every bundled plugin into the state
    // dir first (openclaw-plugin-build-* under tmp/plugin-captures —
    // measured 956MB for ONE run, which alone filled this sandbox's
    // disk and killed the runtime with ENOSPC), and every captured
    // plugin then loads through another tsx transpile storm (the same
    // class of memory burn the heap cap contains). No corpus surface
    // is a bundled plugin — the agent loop, the infer media surfaces
    // and the browser tool are all core surfaces of the pinned
    // revision, and the provider/model selection the corpus tests is
    // pinned by the config file — so discovery-off is the honest,
    // disk-viable certified runtime (disclosed in the evidence record).
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    http_proxy: options.proxyUrl,
    https_proxy: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    TERM: "dumb",
    // Keep the pinned runtime's startup quiet and offline:
    // no update checks, no telemetry, no plugin fetches.
    OPENCLAW_DISABLE_UPDATE_CHECK: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    DO_NOT_TRACK: "1",
    // The image endpoint's loopback gate also honors this QA env (the
    // config axis dangerouslyAllowPrivateNetwork is the primary opt-in;
    // this is the belt-and-braces documented pair).
    OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
  };
}

/** The minimal options the spawn needs (shared by the battery's arms). */
export interface DriverRunOptions {
  readonly proxy: EgressProxy;
  readonly runTimeoutMs?: number;
  /** Extra env entries (the direct-baseline arm overrides NO_PROXY; never credential material). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Run one OpenClaw command (agent exec or infer) to completion,
 * collecting output.
 */
export function runOpenClawCommand(
  options: DriverRunOptions,
  home: string,
  stateDir: string,
  configPath: string,
  workdir: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const env = {
    ...scrubbedOpenClawEnv({
      proxyUrl: options.proxy.url,
      home,
      stateDir,
      configPath,
    }),
    ...(options.extraEnv ?? {}),
  };
  const cli = [...OPENCLAW_RUN_PREFIX, ...args];
  return new Promise((resolve) => {
    const child = spawn("node", cli, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 8 * 1024 * 1024) {
        out = out.slice(0, 8 * 1024 * 1024);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 4 * 1024 * 1024) {
        err = err.slice(0, 4 * 1024 * 1024);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      err += `\n(spawn error: ${error.message})`;
      resolve({ exitCode: 127, stdout: out, stderr: err, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout: out, stderr: err, timedOut });
    });
  });
}

/** One task's per-run directories. */
export interface TaskRunDirs {
  readonly workdir: string;
  readonly home: string;
  readonly stateDir: string;
  readonly configPath: string;
}

/**
 * Prepare the per-task workspace + the shared state dir + the certified
 * config. The STATE DIR is shared across the tasks of one runner scope
 * (one battery/demo composition): the pinned source-checkout runtime
 * captures its plugin package trees into stateDir/tmp/plugin-captures on
 * first load — a shared dir pays that capture cost ONCE instead of once
 * per task (sessions and run state still isolate per run; the task
 * WORKSPACES stay separate directories).
 */
export function prepareTaskRun(
  workspaceRoot: string,
  task: CorpusTask,
  adapterUrl: string,
  browserExecutablePath: string | undefined,
  sharedStateDir?: string,
): TaskRunDirs {
  const workdir = join(workspaceRoot, `task-${task.taskId}`);
  const home = join(workspaceRoot, `task-${task.taskId}-home`);
  const stateDir = sharedStateDir ?? join(workspaceRoot, `task-${task.taskId}-state`);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(workspaceRoot, `task-${task.taskId}-openclaw.json`);
  writeOpenClawConfig(configPath, adapterUrl, browserExecutablePath);
  return { workdir, home, stateDir, configPath };
}

/**
 * Run the corpus: every task through the pinned runtime, mechanically
 * verified, with per-edge execution observations from the adapter's
 * request log (scoped to this run) and the egress violations.
 */
export async function runCorpusTasks(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  const outcomes: CorpusTaskOutcome[] = [];
  const runLabel = new Date().toISOString();
  const sharedStateDir = join(options.workspaceRoot, "shared-state");
  mkdirSync(sharedStateDir, { recursive: true });
  for (const task of tasks) {
    await options.preTaskGuard?.();
    // The browser task's loopback fixture page: served ONLY while that
    // task runs (the task's own declaration names it; every other task
    // serves nothing).
    let loopbackPage: LoopbackTokenPage | null = null;
    if (task.loopbackPage !== undefined) {
      loopbackPage = await createLoopbackTokenPage(
        task.loopbackPage.port,
        task.loopbackPage.token,
      );
    }
    const dirs = prepareTaskRun(
      options.workspaceRoot,
      task,
      options.adapter.url,
      options.browserExecutablePath,
      sharedStateDir,
    );
    task.fixture(dirs.workdir);
    // Stamp the adapter's ambient context so this task's requests are
    // scoped in the adapter's request log (edge-log correlation).
    options.adapter.setRunContext({ corpusTask: task.taskId, runLabel });
    const adapterLogStart = options.adapter.requests().length;
    const railFactsStart = options.railFacts().length;
    const egressStart = options.proxy.violations().length;

    const args =
      task.surface.kind === "agent-exec"
        ? [
            "agent",
            "exec",
            "--config",
            dirs.configPath,
            "--cwd",
            dirs.workdir,
            "--json",
            task.surface.instruction,
          ]
        : [...task.surface.subcommand];
    const timeoutMs =
      task.surface.kind === "agent-exec"
        ? (options.runTimeoutMs ?? 420_000)
        : task.surface.timeoutMs;

    const startedAt = Date.now();
    const result = await runOpenClawCommand(
      options,
      dirs.home,
      dirs.stateDir,
      dirs.configPath,
      dirs.workdir,
      args,
      timeoutMs,
    );
    loopbackPage?.close();
    const durationMs = Date.now() - startedAt;

    const runEdgeLogs = options.adapter
      .requests()
      .slice(adapterLogStart)
      .filter((log) => log.corpusTask === task.taskId);
    const edgeExecutions = runEdgeLogs.map((log) => ({
      edgeId: log.edgeId,
      executionId: log.executionId,
      replayed: log.replayed,
    }));
    const railUsageOf = () => {
      const facts = options.railFacts().slice(railFactsStart);
      const executionIds = new Set(runEdgeLogs.map((log) => log.executionId));
      const scoped = facts.filter((fact) => executionIds.has(fact.executionId));
      return {
        inputTokens: scoped.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
        outputTokens: scoped.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
        dispatches: scoped.length,
        failures: scoped.filter((fact) => fact.outcome === "provider-failure").length,
      };
    };
    const railUsage = railUsageOf();

    let unavailable: CorpusTaskOutcome["unavailable"] = null;
    if (result.timedOut) {
      unavailable = {
        outcome: "NOT-RUN",
        cause: `the task hit its ${timeoutMs}ms wall-clock timeout before completing (a quota-window stall is never recorded as a corpus failure)`,
        owner: "operator-provider boundary (supply pacing/quota)",
      };
    } else if (!existsOpenClawBuild()) {
      unavailable = {
        outcome: "NOT-RUN",
        cause: `the pinned OpenClaw build is absent at ${OPENCLAW_CHECKOUT_DIR} (expected upstream revision f6883b37) — build it per the demo entry's reproducibility instructions`,
        owner: "deployment",
      };
    }

    const verification = unavailable === null ? task.verify({
      workdir: dirs.workdir,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }) : { resolved: false, checkOutput: unavailable.cause };

    const outcome: CorpusTaskOutcome = {
      taskId: task.taskId,
      title: task.title,
      resolved: verification.resolved,
      checkOutput: verification.checkOutput,
      exitCode: result.exitCode,
      durationMs,
      stdoutTail: tailOf(result.stdout),
      stderrTail: tailOf(result.stderr),
      timedOut: result.timedOut,
      edgeExecutions,
      egressViolations: options.proxy.violations().slice(egressStart),
      railUsage,
      unavailable,
    };
    outcomes.push(outcome);
    options.onTaskComplete?.(outcome);
    if (options.interTaskDelayMs !== undefined && options.interTaskDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.interTaskDelayMs));
    }
  }
  void runLabel;
  return outcomes;
}

/** Whether the pinned OpenClaw checkout is runnable (compiled form). */
export function existsOpenClawBuild(): boolean {
  return (
    existsSync(join(OPENCLAW_CHECKOUT_DIR, "src", "entry.js")) &&
    existsSync(join(OPENCLAW_CHECKOUT_DIR, "compiled-runtime.manifest.json")) &&
    existsSync(join(OPENCLAW_CHECKOUT_DIR, "node_modules"))
  );
}

/** Stamp the adapter's ambient run context for one task (edge-log scoping). */
export function stampAdapterRunContext(
  adapter: AdapterServer,
  taskId: string,
  runLabel: string,
): void {
  adapter.setRunContext({ corpusTask: taskId, runLabel });
}
