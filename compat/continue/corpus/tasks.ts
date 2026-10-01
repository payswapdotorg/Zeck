/**
 * The PPR-021 representative coding-assistant corpus — small, real,
 * mechanically verifiable tasks of the kind Continue exists for, each
 * designed to exercise one declared execution-graph edge through the
 * pinned, unmodified Continue runtime running headless:
 *
 *  1. agent-edit-task       (continue.cli.agent-loop.chat) — a real
 *     code edit through the CLI agent loop's Bash/Edit tools with a
 *     verification command the agent runs itself;
 *  2. agent-subagent-delegate (continue.cli.subagent.child-session +
 *     continue.cli.agent-loop.chat) — a task the agent must solve by
 *     spawning the seeded subagent-role model (the config.yaml's own
 *     subagent definition);
 *  3. edit-inline           (continue.core.edit.inline-edit) — the
 *     Cmd+K-style inline edit path over a highlighted code range;
 *  4. apply-fast            (continue.core.apply.fast-apply) — the
 *     fast-apply path merging a lazy code block into a file;
 *  5. autocomplete-tab      (continue.core.autocomplete.tab) — the
 *     tab-autocomplete engine completing a mid-file position;
 *  6. index-embed           (continue.core.indexing.embed) — the
 *     embed-role call the CodebaseIndexer makes (an honest BLOCKED in
 *     this sandbox: the authorized supply exposes no embeddings
 *     surface — probed live; the delegation chain itself runs);
 *  7. rerank-retrieval      (continue.core.retrieval.rerank) — the
 *     rerank-role call the retrieval pipelines make (realized by the
 *     rail's disclosed LLM-scoring over the chat supply).
 *
 * Every task carries: the fresh-workspace fixture builder (pure
 * filesystem writes), the driver task spec (CLI instruction+flags or
 * the role-driver action spec), and a MECHANICAL verifier
 * (deterministic checks over the workspace + run result — never an LLM
 * judging an LLM).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The subagent name the config declares (the CLI's subagent selector). */
export const SUBAGENT_NAME = "Explorer";

export type CorpusDriverKind = "cli" | "role";

export interface CorpusTask {
  readonly taskId: string;
  readonly title: string;
  /** Which of the app's own headless surfaces drives this task. */
  readonly driver: CorpusDriverKind;
  /** The CLI task spec (instruction + flags), for driver === "cli". */
  readonly cli?: {
    readonly instruction: string;
    readonly flags?: readonly string[];
    /**
     * Which of the CLI's OWN headless surfaces drives the task:
     * "print" (default — the `cn -p` one-shot) or "serve" (the CLI's
     * session-aware HTTP surface; REQUIRED for the Subagent tool — the
     * -p mode never aligns the ChatHistoryService session at the pinned
     * revision, so executeSubAgent throws "No active session found").
     */
    readonly mode?: "print" | "serve";
    readonly maxTurnsHintMs?: number;
  };
  /** The role-driver task spec fragment, for driver === "role". */
  readonly role?: {
    readonly action: "edit" | "apply" | "autocomplete" | "embed" | "rerank";
    readonly file?: string;
    readonly instruction?: string;
    readonly new_code?: string;
    readonly range_start?: { line: number; character: number };
    readonly range_end?: { line: number; character: number };
    readonly position?: { line: number; character: number };
    readonly embed_inputs?: readonly string[];
    readonly query?: string;
    readonly documents?: readonly string[];
  };
  /** Build the fresh workspace fixture. */
  readonly fixture: (workdir: string) => void;
  /**
   * Mechanically verify the outcome (workspace + run result). Returns
   * resolved + checkOutput, or an honest BLOCKED unavailability for the
   * embed task (a known required external capability unavailable).
   */
  readonly verify: (input: {
    readonly workdir: string;
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly timedOut: boolean;
    /**
     * The attributed edge executions of THIS run (delegation evidence),
     * or null on the DIRECT-BASELINE arm (which runs with no Zeck adapter
     * — there is no attribution context by definition, so a task whose
     * Zeck-arm verify requires a delegated edge applies only its
     * workspace-level check there).
     */
    readonly edgeExecutions: readonly {
      readonly edgeId: string;
      readonly executionId: string;
      readonly replayed: boolean;
    }[] | null;
  }) => {
    readonly resolved: boolean;
    readonly checkOutput: string;
    readonly blocked?: { readonly cause: string; readonly owner: string };
  };
}

/** Parse the role-driver's machine-readable result line from stdout. */
export function parseRoleDriverResult(
  stdout: string,
): { ok: boolean; blocked: boolean; error: string | null; detail: string; artifact: unknown } | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("CONTINUE_ROLE_RESULT:"));
  if (line === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice("CONTINUE_ROLE_RESULT:".length)) as {
      readonly ok?: unknown;
      readonly blocked?: unknown;
      readonly error?: unknown;
      readonly detail?: unknown;
      readonly artifact?: unknown;
    };
    return {
      ok: parsed.ok === true,
      blocked: parsed.blocked === true,
      error: typeof parsed.error === "string" ? parsed.error : null,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      artifact: parsed.artifact ?? null,
    };
  } catch {
    return null;
  }
}

/** Parse the CLI's headless final response (the last stdout output). */
export function parseCliFinalOutput(stdout: string): string {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Task 1 — agent-loop edit (continue.cli.agent-loop.chat)
// ---------------------------------------------------------------------------

const AGENT_EDIT_TASK: CorpusTask = {
  taskId: "agent-edit-task",
  title: "CLI agent loop: implement a scoring function and verify it",
  driver: "cli",
  cli: {
    instruction:
      "Implement the function wordScore(word) in game.js exactly as documented in its docstring, " +
      "then run the command `node verify.js` with the Bash tool and confirm it prints GAME-OK.",
    flags: ["--auto"],
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
// Task 2 — subagent delegation (continue.cli.subagent.child-session)
// ---------------------------------------------------------------------------

const AGENT_SUBAGENT_DELEGATE: CorpusTask = {
  taskId: "agent-subagent-delegate",
  title: "CLI Subagent tool: delegate workspace inspection to the Explorer subagent",
  driver: "cli",
  cli: {
    mode: "serve",
    instruction:
      `Use the Subagent tool with subagent_name "${SUBAGENT_NAME}" and the prompt ` +
      "'Find the secret word written in the file notes/secret.txt and report it back to me.' " +
      "You MUST delegate this to the subagent — do NOT read notes/secret.txt yourself. " +
      "When the subagent returns, write the secret word it found into a new file named " +
      "secret.txt (just the word on one line) and finish.",
    flags: ["--auto", "--beta-subagent-tool"],
  },
  fixture(workdir) {
    mkdirSync(join(workdir, "notes"), { recursive: true });
    writeFileSync(join(workdir, "notes", "secret.txt"), "The secret word is QUIET-OTTER-42.\n");
  },
  verify({ workdir, edgeExecutions }) {
    const secretPath = join(workdir, "secret.txt");
    if (!existsSync(secretPath)) {
      return { resolved: false, checkOutput: "secret.txt missing" };
    }
    const content = readFileSync(secretPath, "utf8");
    const secretOk = /QUIET-OTTER-42/.test(content);
    // The delegation evidence: on the Zeck arm the subagent child-session
    // edge must have actually executed through Zeck — the task's point is
    // exercising continue.cli.subagent.child-session, so a main-agent
    // shortcut that reads the file itself does NOT resolve this task. On
    // the direct-baseline arm (edgeExecutions === null) there is no
    // attribution context — the workspace-level check alone applies.
    const delegated =
      edgeExecutions === null ||
      edgeExecutions.some((edge) => edge.edgeId === "continue.cli.subagent.child-session");
    const ok = secretOk && delegated;
    return {
      resolved: ok,
      checkOutput: ok
        ? "T2 ok (secret.txt carries the subagent's finding; the child-session edge executed through Zeck)"
        : !secretOk
          ? `secret.txt: ${content.trim().slice(0, 80)}`
          : "secret present but the subagent child-session edge never executed (the main agent shortcut)",
    };
  },
};

// ---------------------------------------------------------------------------
// Task 3 — inline edit (continue.core.edit.inline-edit)
// ---------------------------------------------------------------------------

const EDIT_INLINE: CorpusTask = {
  taskId: "edit-inline",
  title: "Edit role: rewrite a highlighted function through the inline-edit path",
  driver: "role",
  role: {
    action: "edit",
    file: "math.js",
    instruction:
      "Change the highlighted function so it adds its two arguments instead of multiplying them.",
    range_start: { line: 0, character: 0 },
    range_end: { line: 4, character: 0 },
  },
  fixture(workdir) {
    writeFileSync(
      join(workdir, "math.js"),
      [
        "function combine(a, b) {",
        "  // TODO: this should add, not multiply",
        "  return a * b;",
        "}",
        "",
        "module.exports = { combine };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workdir, "verify.js"),
      [
        "const { combine } = require('./math.js');",
        "const ok = combine(2, 3) === 5 && combine(-1, 1) === 0 && combine(10, 20) === 30;",
        "console.log(ok ? 'EDIT-OK' : 'EDIT-FAIL');",
        "process.exit(ok ? 0 : 1);",
        "",
      ].join("\n"),
    );
  },
  verify({ workdir, stdout, exitCode }) {
    const result = parseRoleDriverResult(stdout);
    if (result === null) {
      return { resolved: false, checkOutput: `role driver produced no result (exit ${exitCode})` };
    }
    if (!result.ok) {
      return { resolved: false, checkOutput: `role driver error: ${result.error ?? "unknown"}` };
    }
    try {
      const out = execSync("node verify.js", { cwd: workdir, timeout: 30_000 }).toString();
      const ok = out.includes("EDIT-OK");
      return {
        resolved: ok,
        checkOutput: ok ? "T3 ok (verify.js → EDIT-OK)" : `verify.js output: ${out.trim()}`,
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
// Task 4 — fast apply (continue.core.apply.fast-apply)
// ---------------------------------------------------------------------------

const APPLY_FAST: CorpusTask = {
  taskId: "apply-fast",
  title: "Apply role: merge a lazy code block into a file through the fast-apply path",
  driver: "role",
  role: {
    action: "apply",
    file: "greeting.js",
    new_code: [
      "// CHANGE: greet in Spanish with an exclamation mark",
      "function greet(name) {",
      '  return `Hola, ${name}!`;',
      "}",
    ].join("\n"),
    range_start: { line: 0, character: 0 },
    range_end: { line: 3, character: 0 },
  },
  fixture(workdir) {
    writeFileSync(
      join(workdir, "greeting.js"),
      [
        "function greet(name) {",
        '  return `Hello, ${name}.`;',
        "}",
        "",
        "module.exports = { greet };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workdir, "verify.js"),
      [
        "const { greet } = require('./greeting.js');",
        "const ok = greet('World') === 'Hola, World!';",
        "console.log(ok ? 'APPLY-OK' : 'APPLY-FAIL');",
        "process.exit(ok ? 0 : 1);",
        "",
      ].join("\n"),
    );
  },
  verify({ workdir, stdout, exitCode }) {
    const result = parseRoleDriverResult(stdout);
    if (result === null) {
      return { resolved: false, checkOutput: `role driver produced no result (exit ${exitCode})` };
    }
    if (!result.ok) {
      return { resolved: false, checkOutput: `role driver error: ${result.error ?? "unknown"}` };
    }
    try {
      const out = execSync("node verify.js", { cwd: workdir, timeout: 30_000 }).toString();
      const ok = out.includes("APPLY-OK");
      return {
        resolved: ok,
        checkOutput: ok ? "T4 ok (verify.js → APPLY-OK)" : `verify.js output: ${out.trim()}`,
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
// Task 5 — tab autocomplete (continue.core.autocomplete.tab)
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_TAB: CorpusTask = {
  taskId: "autocomplete-tab",
  title: "Autocomplete role: complete a mid-file position through the tab engine",
  driver: "role",
  role: {
    action: "autocomplete",
    file: "palette.ts",
    position: { line: 9, character: 13 },
  },
  fixture(workdir) {
    writeFileSync(
      join(workdir, "palette.ts"),
      [
        "const PALETTE = [\"crimson\", \"teal\", \"amber\"];",
        "",
        "export function primaryColor(): string {",
        "  // returns the first color of the palette",
        "  return PALETTE[0];",
        "}",
        "",
        "export function secondaryColor(): string {",
        "  // returns the second color of the palette",
        "  return PAI",
        "}",
        "",
      ].join("\n"),
    );
  },
  verify({ stdout, exitCode }) {
    const result = parseRoleDriverResult(stdout);
    if (result === null) {
      return { resolved: false, checkOutput: `role driver produced no result (exit ${exitCode})` };
    }
    if (!result.ok) {
      return { resolved: false, checkOutput: `role driver error: ${result.error ?? "unknown"}` };
    }
    const completion =
      (result.artifact as { readonly completion?: unknown } | null)?.completion ?? "";
    const ok =
      typeof completion === "string" &&
      completion.trim().length > 0 &&
      /LETTE\s*\[\s*1\s*\]/i.test(completion);
    return {
      resolved: ok,
      checkOutput: ok
        ? `T5 ok (completion completed PALETTE[1]: ${JSON.stringify(completion.slice(0, 40))})`
        : `completion did not complete PALETTE[1]: ${JSON.stringify(String(completion).slice(0, 60))}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Task 6 — embeddings (continue.core.indexing.embed) — the honest BLOCKED
// ---------------------------------------------------------------------------

const INDEX_EMBED: CorpusTask = {
  taskId: "index-embed",
  title: "Embed role: the codebase-indexer's embedding call (honest supply boundary)",
  driver: "role",
  role: {
    action: "embed",
    embed_inputs: [
      "The northern sensor array recorded 12 stable readings during the observation window.",
      "The southern depot confirmed inventory of 48 crates, all labeled and stacked.",
      "The eastern route inspection found the bridge clearance unchanged at 4.2 meters.",
      "The western gate log shows 9 deliveries accepted and 2 turned away.",
    ],
  },
  fixture(workdir) {
    mkdirSync(join(workdir, "reports"), { recursive: true });
    writeFileSync(join(workdir, "reports", "notes.txt"), "report files for the index task\n");
  },
  verify({ stdout, exitCode }) {
    const result = parseRoleDriverResult(stdout);
    if (result === null) {
      return { resolved: false, checkOutput: `role driver produced no result (exit ${exitCode})` };
    }
    if (result.ok) {
      // A live embeddings completion would be the resolved outcome (the
      // corpus's declared success check: vectors came back).
      return {
        resolved: true,
        checkOutput: `T6 ok (embed returned vectors: ${JSON.stringify(result.artifact).slice(0, 80)})`,
      };
    }
    // The honest BLOCKED: the delegated embeddings execution failed at
    // the supply boundary (no embeddings-capable rail on the authorized
    // supply — probed live at proof time).
    return {
      resolved: false,
      checkOutput: `T6 BLOCKED (the delegated embeddings execution failed at the supply boundary: ${result.error ?? "unknown"})`,
      blocked: {
        cause:
          "the delegated embeddings execution cannot resolve: the sandbox's authorized supply " +
          "endpoint exposes no embeddings execution surface (probed live at proof time: /embeddings → 404) " +
          "and no external provider credentials exist in this sandbox — the delegation chain itself ran " +
          "(Continue → adapter → Zeck execution → rail dispatch attempt) and the execution landed in FAILED honestly",
        owner: "Lead",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Task 7 — rerank (continue.core.retrieval.rerank)
// ---------------------------------------------------------------------------

const RERANK_RETRIEVAL: CorpusTask = {
  taskId: "rerank-retrieval",
  title: "Rerank role: rank retrieved chunks against a query",
  driver: "role",
  role: {
    action: "rerank",
    query: "What is the capital of France?",
    documents: [
      "The capital of France is Paris, its largest city and seat of government.",
      "Photosynthesis is the process by which plants convert sunlight into energy.",
      "The Python programming language was created by Guido van Rossum in 1991.",
      "Baguettes are a traditional French bread made from wheat flour.",
    ],
  },
  fixture(workdir) {
    mkdirSync(join(workdir, "chunks"), { recursive: true });
    writeFileSync(join(workdir, "chunks", "readme.txt"), "retrieval chunks for the rerank task\n");
  },
  verify({ stdout, exitCode }) {
    const result = parseRoleDriverResult(stdout);
    if (result === null) {
      return { resolved: false, checkOutput: `role driver produced no result (exit ${exitCode})` };
    }
    if (!result.ok) {
      return { resolved: false, checkOutput: `role driver error: ${result.error ?? "unknown"}` };
    }
    const scores =
      (result.artifact as { readonly scores?: unknown } | null)?.scores ?? [];
    if (!Array.isArray(scores) || scores.length !== 4) {
      return { resolved: false, checkOutput: `rerank returned no 4-score array: ${JSON.stringify(scores)}` };
    }
    const argmax = scores.reduce(
      (best, score, index) => (score > (scores[best] ?? -1) ? index : best),
      0,
    );
    const ok = argmax === 0;
    return {
      resolved: ok,
      checkOutput: ok
        ? `T7 ok (the France-capital chunk scored highest: ${JSON.stringify(scores)})`
        : `the top-scored chunk was index ${argmax} (scores ${JSON.stringify(scores)})`,
    };
  },
};

/** The full declared corpus (order = run order). */
export const CORPUS_TASKS: readonly CorpusTask[] = [
  AGENT_EDIT_TASK,
  AGENT_SUBAGENT_DELEGATE,
  EDIT_INLINE,
  APPLY_FAST,
  AUTOCOMPLETE_TAB,
  INDEX_EMBED,
  RERANK_RETRIEVAL,
];

/** A tiny probe task for the duplicate/reuse and failure batteries. */
export const DUPLICATE_PROBE_TASK: CorpusTask = {
  taskId: "duplicate-probe",
  title: "Duplicate/reuse probe: a one-turn deterministic question",
  driver: "cli",
  cli: {
    instruction: "What is 2+2? Answer with just the number, nothing else.",
    flags: ["--auto"],
  },
  fixture(workdir) {
    writeFileSync(join(workdir, "probe.txt"), "2+2\n");
  },
  verify({ stdout, exitCode }) {
    const answer = parseCliFinalOutput(stdout);
    const ok = exitCode === 0 && /4/.test(answer);
    return { resolved: ok, checkOutput: ok ? "probe ok" : `probe answer: ${answer.slice(0, 60)}` };
  },
};
