/**
 * Edge attribution for adapter requests (PPR-018).
 *
 * Every chat-completion request Aider's LiteLLM seam sends is attributed
 * to one of the declared graph's edges by matching the request's FIRST
 * system message against the EXACT prompt constants of the pinned
 * revision (aider/prompts.py at 5dc9490bb35f9729ef2c95d00a19ccd30c26339c):
 *
 *  - `prompts.commit_system`  → the weak-model commit-message edge
 *    (aider/repo.py:get_commit_message);
 *  - `prompts.summarize`      → the chat-history summarizer edge
 *    (aider/history.py:summarize_all);
 *  - anything else            → the main completion edge
 *    (aider/coders/base_coder.py:send).
 *
 * The prefixes below are verbatim prefixes of the pinned constants
 * (stable across the `.format(language_instruction=…)` substitution,
 * which only affects text AFTER the prefix).
 */

export const EDGE_MAIN = "aider.main-completion" as const;
export const EDGE_COMMIT = "aider.commit-message" as const;
export const EDGE_SUMMARIZER = "aider.summarizer" as const;

/** Verbatim prompt prefixes of the pinned revision (aider/prompts.py). */
const COMMIT_SYSTEM_PREFIX =
  "You are an expert software engineer that generates concise, one-line Git commit messages based on the provided diffs.";
const SUMMARIZE_PREFIX =
  "*Briefly* summarize this partial conversation about programming.";

export type AiderEdgeId = typeof EDGE_MAIN | typeof EDGE_COMMIT | typeof EDGE_SUMMARIZER;

/** The Aider model labels of the declared corpus configuration. */
export const MODEL_MAIN = "openai/zeck-coder" as const;
export const MODEL_WEAK = "openai/zeck-weak" as const;

/**
 * Attribute one OpenAI-shaped request to a declared edge. Model-label
 * agreement is recorded (not required — attribution is by prompt
 * signature, the pinned revision's own routing of roles to models).
 */
export function attributeEdge(request: {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}): { readonly edgeId: AiderEdgeId; readonly role: "main" | "weak" | "summarizer" } {
  const firstSystem = request.messages.find((message) => message.role === "system");
  const content = firstSystem?.content ?? "";
  if (content.startsWith(COMMIT_SYSTEM_PREFIX)) {
    return { edgeId: EDGE_COMMIT, role: "weak" };
  }
  if (content.startsWith(SUMMARIZE_PREFIX)) {
    return { edgeId: EDGE_SUMMARIZER, role: "summarizer" };
  }
  return { edgeId: EDGE_MAIN, role: "main" };
}
