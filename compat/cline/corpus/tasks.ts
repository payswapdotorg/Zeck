/**
 * The PPR-019 representative IDE-task corpus — small, real, mechanically
 * verifiable tasks of the kind Cline exists for, each designed to
 * exercise one declared execution-graph edge through the REAL pinned
 * Cline CLI running headless:
 *
 *  1. act-mode-edit   (cline.agent-loop.act) — a real code edit through
 *     the agent's editor/apply-patch tool path + a verification command
 *     the agent runs itself (act-mode tool decisions);
 *  2. plan-mode       (cline.agent-loop.plan) — CLI `--plan` run:
 *     read-only exploration + a structured plan (plan-mode turns);
 *  3. vision-qa       (cline.agent-loop.vision) — an image attachment
 *     question (CLI `@file.png` mention; multimodal content parts);
 *  4. reasoning-math  (cline.agent-loop.reasoning) — CLI `--thinking
 *     high` analytical question (reasoning-effort control on the wire);
 *  5. context-compaction (cline.compaction.agentic +
 *     cline.agent-loop.act) — a multi-file read+summarize+write task
 *     whose provider settings declare a small context window so the
 *     CLI's own default agentic compaction fires mid-task.
 *
 * Every task carries: the fresh-workspace fixture builder (pure
 * filesystem writes), the exact CLI invocation (args), and a MECHANICAL
 * verifier (deterministic checks over the workspace + run result —
 * never an LLM judging an LLM).
 */

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The corpus root (this file's directory). */
const CORPUS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The vision fixture (a deterministic 64×64 solid-orange PNG). */
export const VISION_SWATCH_PATH = join(CORPUS_ROOT, "assets", "orange-swatch.png");

/** The model id the corpus's provider settings carry (opaque neutral string). */
export const CORPUS_MODEL_ID = "glm-4-plus";

export interface CorpusTask {
  readonly taskId: string;
  readonly title: string;
  /** The CLI args (after the preload separator). */
  readonly args: readonly string[];
  /** Provider-settings overrides for this task (e.g. a small context window). */
  readonly settings?: { readonly contextWindow?: number };
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

// ---------------------------------------------------------------------------
// Task 1 — act-mode edit (cline.agent-loop.act)
// ---------------------------------------------------------------------------

const ACT_MODE_EDIT: CorpusTask = {
  taskId: "act-mode-edit",
  title: "Act-mode edit: implement a scoring function and verify it",
  args: [
    "--json",
    "--auto-approve",
    "true",
    "Implement the function wordScore(word) in game.js exactly as documented in its docstring, then run the command `node verify.js` and confirm it prints GAME-OK.",
  ],
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
        "const cases = [",
        "  ['abc', 7], ['aeiou', 5], ['Zz!', 3], ['', 0], ['hello world', 8 + 12 - 4],",
        "];",
        "// hello world: h=3 e=1 l=3 l=3 o=1 (space=0) w=3 o=1 r=3 l=3 d=3 => 24",
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
// Task 2 — plan mode (cline.agent-loop.plan)
// ---------------------------------------------------------------------------

/**
 * Extract the human-visible text from a `--json` NDJSON run (the final
 * answer plus streamed content), so verifiers check the ANSWER and not
 * the JSON envelope (line-structure regexes must not see escaped text).
 */
export function visibleTextOfJsonStdout(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      parts.push(trimmed);
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        readonly type?: string;
        readonly text?: string;
        readonly event?: { readonly type?: string; readonly text?: string; readonly accumulated?: string };
      };
      if (event.type === "run_result" && typeof event.text === "string") {
        parts.push(event.text);
      } else if (event.type === "agent_event" && typeof event.event?.text === "string") {
        parts.push(event.event.text);
      }
    } catch {
      parts.push(trimmed);
    }
  }
  return parts.join("\n");
}

const PLAN_MODE: CorpusTask = {
  taskId: "plan-mode",
  title: "Plan mode: present a structured plan from provided context",
  args: [
    "--plan",
    "--json",
    "This workspace has utils.js containing function shout(text) that returns the uppercased text with '!!!', and a README describing the module. Present a concise numbered plan (3-5 steps, no implementation) for adding a capitalize(text) utility to utils.js together with a verify.js check. End your turn with the plan.",
  ],
  fixture(workdir) {
    writeFileSync(
      join(workdir, "utils.js"),
      [
        "/**",
        " * Small string utilities.",
        " */",
        "function shout(text) {",
        "  return `${text}!!!`.toUpperCase();",
        "}",
        "",
        "module.exports = { shout };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workdir, "README.md"),
      "# utils\n\nA tiny string-utility module. Currently only `shout` exists.\n",
    );
  },
  verify({ stdout, exitCode }) {
    if (exitCode !== 0) {
      return { resolved: false, checkOutput: `exit code ${exitCode}` };
    }
    const text = visibleTextOfJsonStdout(stdout);
    const hasSteps = /(^|\n)\s*1[.)]/.test(text) && /(^|\n)\s*2[.)]/.test(text);
    const mentionsUtil = /capitalize/i.test(text);
    if (hasSteps && mentionsUtil) {
      return { resolved: true, checkOutput: "T2 ok (numbered plan mentioning capitalize)" };
    }
    return {
      resolved: false,
      checkOutput: `plan shape check: steps=${hasSteps} mentionsUtil=${mentionsUtil}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Task 3 — vision QA (cline.agent-loop.vision)
// ---------------------------------------------------------------------------

const VISION_QA: CorpusTask = {
  taskId: "vision-qa",
  title: "Vision QA: identify the dominant color of an image attachment",
  args: [
    "--json",
    "Look at the image @./orange-swatch.png in this workspace. What is its dominant color? Answer with just the color name in your final message.",
  ],
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
    const saidOrange = /orange/i.test(stdout);
    return {
      resolved: saidOrange,
      checkOutput: saidOrange ? "T3 ok (final answer names the color)" : "answer did not name the color",
    };
  },
};

// ---------------------------------------------------------------------------
// Task 4 — reasoning control (cline.agent-loop.reasoning)
// ---------------------------------------------------------------------------

const REASONING_MATH: CorpusTask = {
  taskId: "reasoning-math",
  title: "Reasoning: multi-step arithmetic under --thinking high",
  args: [
    "--thinking",
    "high",
    "--json",
    "Compute the sum of all prime numbers strictly less than 20, then double it. Answer with just the final number in your final message.",
  ],
  fixture(workdir) {
    writeFileSync(join(workdir, "task.txt"), "Sum of primes < 20, doubled.\n");
  },
  verify({ stdout, exitCode }) {
    if (exitCode !== 0) {
      return { resolved: false, checkOutput: `exit code ${exitCode}` };
    }
    // primes < 20: 2+3+5+7+11+13+17+19 = 77; doubled = 154.
    const said154 = /(^|[^0-9])154([^0-9]|$)/.test(stdout);
    return {
      resolved: said154,
      checkOutput: said154 ? "T4 ok (final answer 154)" : "final answer was not 154",
    };
  },
};

// ---------------------------------------------------------------------------
// Task 5 — agentic context compaction (cline.compaction.agentic + act)
// ---------------------------------------------------------------------------

const COMPACTION_FILES = [
  { name: "a.txt", firstWord: "alpha", body: "alpha report: the northern sensor array recorded 12 stable readings during the observation window, with no anomalies worth escalation in this cycle of monitoring work.\n".repeat(6) },
  { name: "b.txt", firstWord: "bravo", body: "bravo report: the southern depot confirmed inventory of 48 crates, all labeled and stacked according to the revised floor plan that was published last month for the crew.\n".repeat(6) },
  { name: "c.txt", firstWord: "charlie", body: "charlie report: the eastern route inspection found the bridge clearance unchanged at 4.2 meters, matching the registry entry that the survey team filed earlier this year.\n".repeat(6) },
  { name: "d.txt", firstWord: "delta", body: "delta report: the western gate log shows 9 deliveries accepted and 2 turned away for missing paperwork, consistent with the quarterly trend the office tracks.\n".repeat(6) },
];

const CONTEXT_COMPACTION: CorpusTask = {
  taskId: "context-compaction",
  title: "Auxiliary edge: multi-file read+write under a small context window (agentic compaction)",
  args: [
    "--json",
    "--auto-approve",
    "true",
    "Read the four report files a.txt, b.txt, c.txt and d.txt in this workspace, then create summary.txt containing exactly four lines: the first word of each report file, in file order (a, b, c, d).",
  ],
  settings: { contextWindow: 9000 },
  fixture(workdir) {
    mkdirSync(join(workdir, "notes"), { recursive: true });
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
    const ok =
      words.length === 4 && expected.every((word, index) => words[index] === word);
    return {
      resolved: ok,
      checkOutput: ok
        ? "T5 ok (summary.txt = alpha/bravo/charlie/delta)"
        : `summary.txt lines: ${JSON.stringify(words)}`,
    };
  },
};

/** The full declared corpus (order = run order). */
export const CORPUS_TASKS: readonly CorpusTask[] = [
  ACT_MODE_EDIT,
  PLAN_MODE,
  VISION_QA,
  REASONING_MATH,
  CONTEXT_COMPACTION,
];

/** A tiny probe task for the duplicate/reuse and failure batteries. */
export const DUPLICATE_PROBE_TASK: CorpusTask = {
  taskId: "duplicate-probe",
  title: "Duplicate/reuse probe: a one-turn deterministic question",
  args: ["--json", "What is 2+2? Answer with just the number."],
  fixture(workdir) {
    writeFileSync(join(workdir, "probe.txt"), "2+2\n");
  },
  verify({ stdout, exitCode }) {
    const ok = exitCode === 0 && /4/.test(stdout);
    return { resolved: ok, checkOutput: ok ? "probe ok" : "probe failed" };
  },
};
