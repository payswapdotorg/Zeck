/**
 * PPR-019 corpus tests — the declared corpus is shape-valid (every task
 * builds its fixture and carries a mechanical verifier), the verifiers
 * REJECT wrong states (negative controls), and the vision fixture is a
 * real PNG.
 */

import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { CORPUS_TASKS, DUPLICATE_PROBE_TASK, VISION_SWATCH_PATH } from "../corpus/tasks";

function freshWorkdir(name: string): string {
  const dir = join(tmpdir(), `ppr-019-corpus-${name}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("PPR-019 corpus shape", () => {
  test("the corpus declares exactly the five edge-covering tasks in run order", () => {
    expect(CORPUS_TASKS.map((task) => task.taskId)).toEqual([
      "act-mode-edit",
      "plan-mode",
      "vision-qa",
      "reasoning-math",
      "context-compaction",
    ]);
  });

  test("every task builds a fixture and carries args with a prompt", () => {
    for (const task of [...CORPUS_TASKS, DUPLICATE_PROBE_TASK]) {
      expect(task.args.length).toBeGreaterThanOrEqual(1);
      expect(typeof task.fixture).toBe("function");
      expect(typeof task.verify).toBe("function");
      expect(task.title.length).toBeGreaterThan(10);
      const workdir = freshWorkdir(task.taskId);
      try {
        task.fixture(workdir);
        expect(existsSync(workdir)).toBe(true);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }
  });

  test("the corpus exercises plan mode, act mode, vision, reasoning and compaction through the CLI's own flags", () => {
    const planTask = CORPUS_TASKS.find((task) => task.taskId === "plan-mode");
    expect(planTask?.args).toContain("--plan");
    const reasoningTask = CORPUS_TASKS.find((task) => task.taskId === "reasoning-math");
    const thinkingIndex = reasoningTask?.args.indexOf("--thinking") ?? -1;
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningTask?.args[thinkingIndex + 1]).toBe("high");
    const actTask = CORPUS_TASKS.find((task) => task.taskId === "act-mode-edit");
    expect(actTask?.args).toContain("--auto-approve");
    const compactionTask = CORPUS_TASKS.find((task) => task.taskId === "context-compaction");
    expect(compactionTask?.settings?.contextWindow).toBeDefined();
  });
});

describe("PPR-019 corpus verifiers (negative controls)", () => {
  test("T1 rejects the unimplemented stub and passes a correct implementation", () => {
    const task = CORPUS_TASKS.find((t) => t.taskId === "act-mode-edit");
    if (task === undefined) throw new Error("task missing");
    const workdir = freshWorkdir("t1-neg");
    try {
      task.fixture(workdir);
      // The stub (TODO still present) must NOT verify.
      const stubResult = task.verify({ workdir, stdout: "", stderr: "", exitCode: 0 });
      expect(stubResult.resolved).toBe(false);
      // A correct implementation must verify.
      writeFileSync(
        join(workdir, "game.js"),
        [
          "function wordScore(word) {",
          "  let score = 0;",
          "  for (const ch of word) {",
          "    if ('aeiou'.includes(ch)) score += 1;",
          "    else if (ch >= 'a' && ch <= 'z') score += 3;",
          "  }",
          "  return score;",
          "}",
          "module.exports = { wordScore };",
          "",
        ].join("\n"),
      );
      const okResult = task.verify({ workdir, stdout: "", stderr: "", exitCode: 0 });
      expect(okResult.resolved).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("T2 (plan) rejects a non-zero exit and a step-less answer", () => {
    const task = CORPUS_TASKS.find((t) => t.taskId === "plan-mode");
    if (task === undefined) throw new Error("task missing");
    expect(task.verify({ workdir: "/tmp", stdout: "no steps here", stderr: "", exitCode: 1 }).resolved).toBe(false);
    expect(task.verify({ workdir: "/tmp", stdout: "1. first\n2. second: add capitalize", stderr: "", exitCode: 0 }).resolved).toBe(true);
  });

  test("T4 (reasoning) accepts exactly the correct doubled prime sum (154)", () => {
    const task = CORPUS_TASKS.find((t) => t.taskId === "reasoning-math");
    if (task === undefined) throw new Error("task missing");
    expect(task.verify({ workdir: "/tmp", stdout: "The answer is 154.", stderr: "", exitCode: 0 }).resolved).toBe(true);
    expect(task.verify({ workdir: "/tmp", stdout: "The answer is 77.", stderr: "", exitCode: 0 }).resolved).toBe(false);
    expect(task.verify({ workdir: "/tmp", stdout: "1154 items", stderr: "", exitCode: 0 }).resolved).toBe(false);
  });

  test("T5 (compaction) verifies exactly the four first words in order", () => {
    const task = CORPUS_TASKS.find((t) => t.taskId === "context-compaction");
    if (task === undefined) throw new Error("task missing");
    const workdir = freshWorkdir("t5");
    try {
      task.fixture(workdir);
      expect(task.verify({ workdir, stdout: "", stderr: "", exitCode: 0 }).resolved).toBe(false);
      writeFileSync(join(workdir, "summary.txt"), "alpha\nbravo\ncharlie\ndelta\n");
      expect(task.verify({ workdir, stdout: "", stderr: "", exitCode: 0 }).resolved).toBe(true);
      writeFileSync(join(workdir, "summary.txt"), "bravo\nalpha\ncharlie\ndelta\n");
      expect(task.verify({ workdir, stdout: "", stderr: "", exitCode: 0 }).resolved).toBe(false);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("PPR-019 vision fixture", () => {
  test("the swatch is a real PNG file on disk", () => {
    expect(existsSync(VISION_SWATCH_PATH)).toBe(true);
    const bytes = readFileSync(VISION_SWATCH_PATH);
    expect(bytes.length).toBeGreaterThan(50);
    // The PNG magic signature.
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  test("the vision task references the fixture through a loadable @-mention", () => {
    const task = CORPUS_TASKS.find((t) => t.taskId === "vision-qa");
    const prompt = task?.args[task.args.length - 1] ?? "";
    // The CLI's image loader fires only on @-mentions with a path prefix
    // (./, /, ~/, ../) — the mention must be exactly loadable.
    expect(prompt).toContain("@./orange-swatch.png");
    expect(prompt.toLowerCase()).toContain("color");
  });
});
