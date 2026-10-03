/**
 * The PPR-024 representative corpus — the two-plane declaration the work
 * order demands:
 *
 *  1. browseruse-model-structured — a PURE-MODEL task: a direct
 *     structured invocation through the application's own ChatOpenAI
 *     abstraction (no browser session exists at all). Proves the
 *     model/intelligence plane SEPARATELY.
 *
 *  2. browseruse-actuation-reveal — a task whose material value is
 *     ENTIRELY the browser actuation: the delegated substrate client
 *     navigates to the loopback fixture page, reads the DOM state,
 *     clicks the reveal button and reads the revealed token — every
 *     operation a REAL Zeck execution on the substrate plane, with NO
 *     LLM turn. Proves the actuation plane SEPARATELY.
 *
 *  3. browseruse-agent-combined — the COMBINED task: the full pinned
 *     Agent loop over the same fixture page — the delegated LLM chooses
 *     the actions (navigate / click / done) the delegated substrate
 *     executes. Proves BOTH planes TOGETHER.
 *
 * Mechanical verification (the corpus's own declared success checks —
 * never a Zeck verification authority): the model task's structured
 * fields; the actuation task's extracted token; the combined task's
 * final result containing the token.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The non-empty placeholder the OpenAI-compatible clients require (authenticates nothing). */
export const CORPUS_API_KEY_PLACEHOLDER = "zeck-local-adapter" as const;

/** The model identities the certified configuration pins (opaque neutral strings). */
export const CORPUS_MAIN_MODEL = "glm-4-plus" as const;

/** The fixture page's token material (mechanical verification targets). */
export const REVEAL_TOKEN = "ZK24ACTDELEG8421" as const;
export const REVEAL_BUTTON_TEXT = "Reveal the access token" as const;
export const REVEAL_TOKEN_MARKER = "ACCESS-TOKEN:" as const;

export type CorpusTaskKind = "model" | "actuation" | "agent";

export interface CorpusTask {
  readonly taskId: string;
  readonly title: string;
  /** The corpus task instruction/description (rendered in evidence). */
  readonly instruction: string;
  readonly kind: CorpusTaskKind;
  /** The mechanical success check over the runner's result JSON. */
  verify(result: Readonly<Record<string, unknown>>): {
    readonly resolved: boolean;
    readonly checkOutput: string;
  };
}

export const CORPUS_TASKS: readonly CorpusTask[] = [
  {
    taskId: "browseruse-model-structured",
    title: "Pure-model structured extraction (no browser)",
    instruction:
      "From the following release note, produce the structured summary {headline, impact, ok} — the application's own ChatOpenAI abstraction invoked directly with a structured output format (no browser session is constructed for this task).",
    kind: "model",
    verify(result) {
      const final = String(result.finalResult ?? "");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(final) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const headline = typeof parsed?.headline === "string" ? parsed.headline : "";
      const impact = typeof parsed?.impact === "string" ? parsed.impact : "";
      const ok = parsed?.ok === true;
      const resolved = headline.length > 0 && impact.length > 0 && ok === true;
      return {
        resolved,
        checkOutput: resolved
          ? `structured fields extracted through the delegated model seam (headline ${headline.length} chars, impact ${impact.length} chars, ok=true)`
          : `structured fields missing or invalid (headline=${JSON.stringify(headline)}, impact=${JSON.stringify(impact)}, ok=${String(parsed?.ok)})`,
      };
    },
  },
  {
    taskId: "browseruse-actuation-reveal",
    title: "Actuation-only reveal (delegated substrate, no LLM turn)",
    instruction: `Navigate to the fixture page, click the "${REVEAL_BUTTON_TEXT}" button, and extract the revealed access token from the page — driven through the delegated browser substrate with no model turn.`,
    kind: "actuation",
    verify(result) {
      const token = String(result.finalResult ?? "");
      const resolved = token === REVEAL_TOKEN;
      return {
        resolved,
        checkOutput: resolved
          ? `the delegated substrate navigated, clicked and read the revealed token (${token})`
          : `the revealed token was not extracted (got ${JSON.stringify(token.slice(0, 60))}; error=${String(result.error ?? "none").slice(0, 200)})`,
      };
    },
  },
  {
    taskId: "browseruse-agent-combined",
    title: "Combined agent task (delegated model chooses, delegated substrate executes)",
    instruction: `Open the page at the given URL in your browser, click the "${REVEAL_BUTTON_TEXT}" button, then report the revealed access token in your final answer and finish.`,
    kind: "agent",
    verify(result) {
      const final = String(result.finalResult ?? "");
      const resolved = final.includes(REVEAL_TOKEN);
      const steps = Array.isArray(result.steps) ? result.steps : [];
      return {
        resolved,
        checkOutput: resolved
          ? `the agent loop resolved the task in ${steps.length} action(s) and reported the revealed token (${steps.slice(0, 8).join(", ")})`
          : `the agent's final result did not contain the revealed token (got ${JSON.stringify(final.slice(0, 120))}; steps=${steps.slice(0, 8).join(", ")}; errors=${String(JSON.stringify(result.errors ?? [])).slice(0, 200)})`,
      };
    },
  },
];

/** The release-note text the pure-model task extracts from (bounded, self-contained). */
export const MODEL_TASK_INPUT =
  "Extract the structured summary of this release note into the output schema (headline: a short title; impact: one sentence; ok: true when the summary is coherent). Respond with ONLY the JSON object.\n\nRelease note: Zeck 0.13 delegates every material AI execution edge of the pinned Browser Use runtime — both the model plane and the browser actuation plane — through one stable public contract. Impact: the application erased its direct provider infrastructure while retaining its own agent domain. Set ok=true when this summary is coherent." as const;

/** The runner task spec for one corpus task (written to the task file). */
export function runnerTaskOf(
  task: CorpusTask,
  fixtureUrl: string,
): Readonly<Record<string, unknown>> {
  if (task.kind === "model") {
    return {
      taskId: task.taskId,
      kind: "model",
      instruction: `${MODEL_TASK_INPUT}`,
      outputFields: {
        headline: "string",
        impact: "string",
        ok: "boolean",
      },
      // (typed fields — the runner maps them onto a pydantic output model)
      temperature: 0.0,
    };
  }
  if (task.kind === "actuation") {
    return {
      taskId: task.taskId,
      kind: "actuation",
      url: fixtureUrl,
      clickText: REVEAL_BUTTON_TEXT,
      tokenMarker: REVEAL_TOKEN_MARKER,
    };
  }
  return {
    taskId: task.taskId,
    kind: "agent",
    instruction: `${task.instruction} The URL is ${fixtureUrl}`,
    maxSteps: 12,
  };
}

/** Write the runner task spec to its file (the runner's PPR_024_TASK_FILE). */
export function writeRunnerTaskFile(file: string, task: CorpusTask, fixtureUrl: string): void {
  const spec = runnerTaskOf(task, fixtureUrl);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
}

/** The representative task id the demo entry names. */
export const REPRESENTATIVE_TASK_ID = "browseruse-agent-combined" as const;
