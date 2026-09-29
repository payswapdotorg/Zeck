/**
 * The PPR-020 representative coding-agent corpus — small, real,
 * mechanically verifiable tasks of the kind OpenHands exists for, each
 * designed to exercise one declared execution-graph edge through the
 * REAL pinned OpenHands agent SDK running headless:
 *
 *  1. implement-edit      (openhands.agent-loop.main) — a real code
 *     edit through the agent's file_editor tool + a verification
 *     command the agent runs itself via the terminal tool;
 *  2. vision-qa           (openhands.agent-loop.vision) — an image
 *     attachment question (SDK ImageContent → multimodal content
 *     parts);
 *  3. context-compaction  (openhands.condenser.llm-summarize +
 *     openhands.agent-loop.main) — a multi-file read+write task whose
 *     agent runs with a small LLMSummarizingCondenser max_size so the
 *     condenser's own summarization call fires mid-task;
 *  4. delegate-explore    (openhands.subagent.task-loop +
 *     openhands.agent-loop.main) — a task the agent must solve by
 *     spawning the seeded `explorer` sub-agent (a project-level
 *     .agents/agents/explorer.md definition, model: inherit — the
 *     app's own file-based agent configuration surface);
 *  5. oracle-consult      (openhands.tool.ask-oracle +
 *     openhands.agent-loop.main) — a question the agent must answer
 *     after consulting the ask_oracle tool (a saved `oracle` LLM
 *     profile seeded through the SDK's own LLMProfileStore, pointing
 *     at the SAME delegated seam).
 *
 * Every task carries: the fresh-workspace fixture builder (pure
 * filesystem writes), the driver task-spec fragment (instruction,
 * tools, options), and a MECHANICAL verifier (deterministic checks over
 * the workspace + run result — never an LLM judging an LLM).
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The corpus root (this file's directory). */
const CORPUS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The vision fixture (a deterministic 64×64 solid-orange PNG). */
export const VISION_SWATCH_PATH = join(CORPUS_ROOT, "assets", "orange-swatch.png");

/**
 * The model id the corpus's LLM configuration carries (an opaque neutral
 * string to OpenHands; the rail owns the actual supply model). The
 * litellm `openai/` prefix routes the request to the OpenAI-compatible
 * transport pointed at the local Zeck adapter.
 */
export const CORPUS_MODEL_ID = "openai/glm-4-plus";

/** The placeholder the litellm client's shape check requires (never a credential). */
export const CORPUS_API_KEY_PLACEHOLDER = "zeck-local-adapter";

/** The seeded sub-agent definition (the app's own file-based agent surface). */
export const EXPLORER_AGENT_NAME = "explorer";
const EXPLORER_AGENT_MARKDOWN = `---
name: ${EXPLORER_AGENT_NAME}
model: inherit
description: >-
    USE THIS to inspect the workspace and report facts found in files.
    Give the caller exactly the facts it asked for.
tools:
  - terminal
---

You are a workspace exploration specialist. Your sole interface is the
terminal — use it to run read-only shell commands that inspect the
workspace and report the exact facts the caller asked for.
`;

export interface CorpusTask {
  readonly taskId: string;
  readonly title: string;
  /** The driver task-spec fragment (instruction, tools, options). */
  readonly spec: {
    readonly instruction: string;
    readonly tools: readonly string[];
    readonly followups?: readonly string[];
    readonly condenser?: { readonly maxSize: number; readonly keepFirst: number };
    readonly seedOracleProfile?: boolean;
    readonly image?: string;
    readonly maxIterations?: number;
  };
  /** Build the fresh workspace fixture. */
  readonly fixture: (workdir: string) => void;
  /** Mechanically verify the outcome (workspace + run result). */
  readonly verify: (input: {
    readonly workdir: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }) => { readonly resolved: boolean; readonly checkOutput: string };
}

/** Parse the driver's machine-readable result line from stdout. */
export function parseDriverResult(
  stdout: string,
): { ok: boolean; finalMessage: string; error: string | null } | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("OPENHANDS_RESULT:"));
  if (line === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice("OPENHANDS_RESULT:".length)) as {
      readonly ok?: unknown;
      readonly final_message?: unknown;
      readonly error?: unknown;
    };
    return {
      ok: parsed.ok === true,
      finalMessage: typeof parsed.final_message === "string" ? parsed.final_message : "",
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task 1 — implement + verify edit (openhands.agent-loop.main)
// ---------------------------------------------------------------------------

const IMPLEMENT_EDIT: CorpusTask = {
  taskId: "implement-edit",
  title: "Agent loop: implement a scoring function and verify it",
  spec: {
    instruction:
      "Implement the function wordScore(word) in game.js exactly as documented in its docstring, " +
      "then run the command `node verify.js` with the terminal tool and confirm it prints GAME-OK.",
    tools: ["terminal", "file_editor", "task_tracker"],
    maxIterations: 40,
  },
  fixture(workdir) {
    writeFileSync(
      join(workdir, "game.js"),
      [
        "/**",
        " * Score a word for a word game.",
        " *",
        " * The score is the sum of letter values: vowels (a, e, i, o, u) are worth",
        " * 1 point each; every other lowercase letter is worth 3 points. Characters",
        " * that are not lowercase letters (uppercase, digits, punctuation, spaces)",
        " * are worth 0 points.",
        " */",
        "function wordScore(word) {",
        "  // TODO: implement per the docstring above",
        "}",
        "",
        "module.exports = { wordScore };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workdir, "verify.js"),
      [
        "const { wordScore } = require('./game.js');",
        "// abc: a=1 b=3 c=3 = 7; aeiou = 5; Zz! = 3 (Z=0 z=3 != 0); '' = 0;",
        "// hello world: h=3 e=1 l=3 l=3 o=1 (space=0) w=3 o=1 r=3 l=3 d=3 = 24",
        "const fixed = [",
        "  ['abc', 7], ['aeiou', 5], ['Zz!', 3], ['', 0], ['hello world', 24],",
        "];",
        "let ok = true;",
        "for (const [word, expected] of fixed) {",
        "  const got = wordScore(word);",
        "  if (got !== expected) { ok = false; console.error(`FAIL ${JSON.stringify(word)}: expected ${expected}, got ${got}`); }",
        "}",
        "console.log(ok ? 'GAME-OK' : 'GAME-FAIL');",
        "process.exit(ok ? 0 : 1);",
        "",
      ].join("\n"),
    );
  },
  verify({ workdir }) {
    const gamePath = join(workdir, "game.js");
    if (!existsSync(gamePath)) {
      return { resolved: false, checkOutput: "game.js missing" };
    }
    const source = readFileSync(gamePath, "utf8");
    if (/TODO: implement/.test(source)) {
      return { resolved: false, checkOutput: "game.js still contains the TODO stub" };
    }
    try {
      const out = execSync("node verify.js", { cwd: workdir, timeout: 30_000 }).toString();
      const ok = out.includes("GAME-OK");
      return {
        resolved: ok,
        checkOutput: ok ? "T1 ok (verify.js → GAME-OK)" : `verify.js output: ${out.trim()}`,
      };
    } catch (error) {
      return {
        resolved: false,
        checkOutput: `verify.js failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Task 2 — vision QA (openhands.agent-loop.vision)
// ---------------------------------------------------------------------------

const VISION_QA: CorpusTask = {
  taskId: "vision-qa",
  title: "Agent loop (vision): identify the dominant color of an image attachment",
  spec: {
    instruction:
      "Look at the image attached to THIS message. What is its dominant color? " +
      "Answer directly from the attached image itself: reply with just the color " +
      "name as your final message. Do not search the workspace for image files, " +
      "do not run any commands, and do not look for image files on disk — the " +
      "image is attached to this very message, and your final message must be " +
      "just the color name.",
    tools: ["terminal"],
    image: "orange-swatch.png",
    maxIterations: 15,
  },
  fixture(workdir) {
    copyFileSync(VISION_SWATCH_PATH, join(workdir, "orange-swatch.png"));
  },
  verify({ workdir, stdout, exitCode }) {
    if (!existsSync(join(workdir, "orange-swatch.png"))) {
      return { resolved: false, checkOutput: "fixture image missing" };
    }
    if (exitCode !== 0) {
      return { resolved: false, checkOutput: `exit code ${exitCode}` };
    }
    const result = parseDriverResult(stdout);
    const colorFile = existsSync(join(workdir, "color.txt"))
      ? readFileSync(join(workdir, "color.txt"), "utf8")
      : "";
    const saidOrange = /orange/i.test(`${result?.finalMessage ?? ""} ${colorFile}`);
    return {
      resolved: saidOrange,
      checkOutput: saidOrange
        ? "T2 ok (final answer names the color)"
        : "answer did not name the color",
    };
  },
};

// ---------------------------------------------------------------------------
// Task 3 — condenser summarization (openhands.condenser.llm-summarize)
// ---------------------------------------------------------------------------

const COMPACTION_FILES = [
  {
    name: "a.txt",
    firstWord: "alpha",
    body: "alpha report: the northern sensor array recorded 12 stable readings during the observation window, with no anomalies worth escalation in this cycle of monitoring work.\n".repeat(6),
  },
  {
    name: "b.txt",
    firstWord: "bravo",
    body: "bravo report: the southern depot confirmed inventory of 48 crates, all labeled and stacked according to the revised floor plan that was published last month for the crew.\n".repeat(6),
  },
  {
    name: "c.txt",
    firstWord: "charlie",
    body: "charlie report: the eastern route inspection found the bridge clearance unchanged at 4.2 meters, matching the registry entry that the survey team filed earlier this year.\n".repeat(6),
  },
  {
    name: "d.txt",
    firstWord: "delta",
    body: "delta report: the western gate log shows 9 deliveries accepted and 2 turned away for missing paperwork, consistent with the quarterly trend the office tracks.\n".repeat(6),
  },
];

const CONTEXT_COMPACTION: CorpusTask = {
  taskId: "context-compaction",
  title: "Condenser: multi-file read+append under a small condenser max_size",
  spec: {
    instruction:
      "Process the four report files a.txt, b.txt, c.txt and d.txt STRICTLY one at a time, " +
      "in this exact order: (1) run `cat a.txt`, then append its FIRST word as a new line to " +
      "notes/words.txt; (2) run `cat b.txt`, append its first word; (3) run `cat c.txt`, append " +
      "its first word; (4) run `cat d.txt`, append its first word — one cat and one append per " +
      "file, never batched. After all four are processed, create summary.txt containing exactly " +
      "the four lines you appended to notes/words.txt (you may re-read notes/words.txt to build it).",
    tools: ["terminal", "file_editor"],
    condenser: { maxSize: 10, keepFirst: 2 },
    maxIterations: 60,
  },
  fixture(workdir) {
    mkdirSync(join(workdir, "notes"), { recursive: true });
    writeFileSync(join(workdir, "notes", "words.txt"), "");
    for (const file of COMPACTION_FILES) {
      writeFileSync(join(workdir, file.name), file.body);
    }
  },
  verify({ workdir }) {
    const summaryPath = join(workdir, "summary.txt");
    if (!existsSync(summaryPath)) {
      return { resolved: false, checkOutput: "summary.txt missing" };
    }
    const content = readFileSync(summaryPath, "utf8");
    const words = content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);
    const expected = COMPACTION_FILES.map((file) => file.firstWord);
    const ok = words.length === 4 && expected.every((word, index) => words[index] === word);
    return {
      resolved: ok,
      checkOutput: ok
        ? "T3 ok (summary.txt = alpha/bravo/charlie/delta)"
        : `summary.txt lines: ${JSON.stringify(words)}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Task 4 — sub-agent delegation (openhands.subagent.task-loop)
// ---------------------------------------------------------------------------

const DELEGATE_EXPLORE: CorpusTask = {
  taskId: "delegate-explore",
  title: "Sub-agent loop: delegate workspace inspection to the explorer sub-agent",
  spec: {
    instruction:
      "Use the task tool to spawn the `explorer` sub-agent with this task: 'Find the secret word " +
      "written in the file notes/secret.txt and report it.' When the sub-agent returns, write the " +
      "secret word into secret.txt and finish.",
    tools: ["terminal", "task_tool_set"],
    maxIterations: 40,
  },
  fixture(workdir) {
    mkdirSync(join(workdir, ".agents", "agents"), { recursive: true });
    writeFileSync(join(workdir, ".agents", "agents", `${EXPLORER_AGENT_NAME}.md`), EXPLORER_AGENT_MARKDOWN);
    mkdirSync(join(workdir, "notes"), { recursive: true });
    writeFileSync(join(workdir, "notes", "secret.txt"), "The secret word is QUIET-OTTER-42.\n");
  },
  verify({ workdir }) {
    const secretPath = join(workdir, "secret.txt");
    if (!existsSync(secretPath)) {
      return { resolved: false, checkOutput: "secret.txt missing" };
    }
    const content = readFileSync(secretPath, "utf8");
    const ok = /QUIET-OTTER-42/.test(content);
    return {
      resolved: ok,
      checkOutput: ok ? "T4 ok (secret.txt carries the sub-agent's finding)" : `secret.txt: ${content.trim().slice(0, 80)}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Task 5 — oracle consult (openhands.tool.ask-oracle)
// ---------------------------------------------------------------------------

const ORACLE_CONSULT: CorpusTask = {
  taskId: "oracle-consult",
  title: "Auxiliary model client: consult the oracle profile before answering",
  spec: {
    instruction:
      "Your FIRST action MUST be a call to the ask_oracle tool with the question: 'I need to " +
      "write the product of 17 and 23 into answer.txt — what number should I write?' This call " +
      "is mandatory and verified: do not skip it, and do not write any file before the oracle " +
      "has responded. After the oracle responds, write the number it recommends into answer.txt " +
      "(just the number) and finish.",
    tools: ["ask_oracle", "file_editor", "terminal"],
    seedOracleProfile: true,
    maxIterations: 30,
  },
  fixture(workdir) {
    writeFileSync(join(workdir, "task.txt"), "17 * 23 = ?\n");
  },
  verify({ workdir }) {
    const answerPath = join(workdir, "answer.txt");
    if (!existsSync(answerPath)) {
      return { resolved: false, checkOutput: "answer.txt missing" };
    }
    const content = readFileSync(answerPath, "utf8");
    const ok = /(^|[^0-9])391([^0-9]|$)/.test(content);
    return {
      resolved: ok,
      checkOutput: ok ? "T5 ok (answer.txt = 391)" : `answer.txt: ${content.trim().slice(0, 80)}`,
    };
  },
};

/** The full declared corpus (order = run order). */
export const CORPUS_TASKS: readonly CorpusTask[] = [
  IMPLEMENT_EDIT,
  VISION_QA,
  CONTEXT_COMPACTION,
  DELEGATE_EXPLORE,
  ORACLE_CONSULT,
];

/** A tiny probe task for the duplicate/reuse and failure batteries. */
export const DUPLICATE_PROBE_TASK: CorpusTask = {
  taskId: "duplicate-probe",
  title: "Duplicate/reuse probe: a one-turn deterministic question",
  spec: {
    instruction: "What is 2+2? Answer with just the number in your final message.",
    tools: [],
    maxIterations: 10,
  },
  fixture(workdir) {
    writeFileSync(join(workdir, "probe.txt"), "2+2\n");
  },
  verify({ stdout, exitCode }) {
    const result = parseDriverResult(stdout);
    const ok = exitCode === 0 && result !== null && /4/.test(result.finalMessage);
    return { resolved: ok, checkOutput: ok ? "probe ok" : "probe failed" };
  },
};
