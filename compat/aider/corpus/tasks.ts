/**
 * The PPR-018 representative coding corpus (work-order battery step 4).
 *
 * Five real coding-assistant tasks, each materialized as a fresh git
 * repository, driven through real pinned Aider, and verified
 * MECHANICALLY (each task ships its own check script run with the
 * venv's Python; exit 0 = resolved):
 *
 *  - T1 implement-function  — implement a pure function from a spec;
 *  - T2 fix-bug            — fix a seeded bug so the module's tests pass;
 *  - T3 add-feature        — add a new function to an existing module;
 *  - T4 refactor-extract   — extract duplicated logic into a helper;
 *  - T5 multi-turn         — four sequential turns on one repo (drives
 *                            the chat-history summarizer edge by
 *                            exceeding max_chat_history_tokens=1024).
 *
 * The multi-turn task is the corpus's summarizer trigger: the pinned
 * revision checks history size after every turn
 * (aider/coders/base_coder.py:move_back_cur_messages →
 * summarize_start) and summarizes once done_messages exceed the
 * threshold — with whole-file edit responses, turns 3-4 cross it.
 */

/** One corpus task's definition (data only — the runner materializes it). */
export interface CorpusTask {
  readonly id: string;
  readonly title: string;
  readonly turns: readonly string[];
  /**
   * Files written into the fresh repo before Aider runs (path →
   * content). Every task carries its mechanical check as check.py (run
   * with the venv Python; exit 0 = resolved).
   */
  readonly files: Readonly<Record<string, string>>;
  /** Files Aider is told to work on (--file flags). */
  readonly chatFiles: readonly string[];
}

export const CODING_CORPUS: readonly CorpusTask[] = [
  {
    id: "implement-function",
    title: "Implement word_score per spec",
    turns: [
      "Implement the word_score function in game.py exactly per its docstring specification. Keep the function name and signature unchanged.",
    ],
    chatFiles: ["game.py"],
    files: {
      "game.py": `def word_score(word):
    """Score a word for a word game.

    The score is the sum of letter values: vowels (a, e, i, o, u) are
    worth 1 point each; every other lowercase letter is worth 3 points.
    Non-lowercase characters (uppercase, digits, punctuation, spaces)
    are worth 0 points.

    Examples:
      word_score("abc") == 7   # a=1, b=3, c=3
      word_score("aeiou") == 5
      word_score("Zz!") == 3   # Z=0, z=3, !=0
    """
    raise NotImplementedError("implement me")
`,
      "check.py": `from game import word_score

assert word_score("abc") == 7, word_score("abc")
assert word_score("aeiou") == 5
assert word_score("Zz!") == 3
assert word_score("") == 0
assert word_score("hello world") == 24, word_score("hello world")
assert word_score("xyz") == 9
print("T1 ok")
`,
    },
  },
  {
    id: "fix-bug",
    title: "Fix the discount rounding bug in cart.py",
    turns: [
      "cart.py has a bug: apply_discount computes the wrong final price. Read the failing behavior in the docstring, fix apply_discount so the examples hold, and keep everything else unchanged.",
    ],
    chatFiles: ["cart.py"],
    files: {
      "cart.py": `def apply_discount(price_cents, percent):
    """Apply a percentage discount to a price in cents.

    The result must be rounded HALF UP to the nearest whole cent
    (standard rounding: 0.5 rounds up), and never negative.

    Examples (currently WRONG — fix the implementation):
      apply_discount(1000, 10) should be 900
      apply_discount(999, 50) should be 500   # 499.5 rounds half-up to 500
      apply_discount(250, 100) should be 0
      apply_discount(100, 0) should be 100
    """
    import math
    # BUG: banker's rounding (round) is used instead of half-up,
    # and the floor can produce negative results.
    return max(0, round(price_cents * (100 - percent) / 100))
`,
      "check.py": `from cart import apply_discount

assert apply_discount(1000, 10) == 900, apply_discount(1000, 10)
assert apply_discount(999, 50) == 500, apply_discount(999, 50)
assert apply_discount(250, 100) == 0
assert apply_discount(100, 0) == 100
assert apply_discount(101, 99) == 1, apply_discount(101, 99)
print("T2 ok")
`,
    },
  },
  {
    id: "add-feature",
    title: "Add slugify to strutil.py",
    turns: [
      "Add a new function slugify(text) to strutil.py. It must: lowercase the text, strip leading/trailing hyphens, replace any run of non-alphanumeric characters with a single hyphen, and return the result. Add a short docstring. Do not change the existing functions.",
    ],
    chatFiles: ["strutil.py"],
    files: {
      "strutil.py": `def truncate(text, limit):
    """Truncate text to limit characters, appending an ellipsis when cut."""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def title_case(text):
    """Capitalize the first letter of every word."""
    return " ".join(word.capitalize() for word in text.split())
`,
      "check.py": `from strutil import slugify, truncate, title_case

assert slugify("Hello, World!") == "hello-world", slugify("Hello, World!")
assert slugify("  Multiple   Spaces  ") == "multiple-spaces"
assert slugify("already-slug") == "already-slug"
assert slugify("---edges---") == "edges"
assert slugify("Mix3d Numb3rs & Symbols!") == "mix3d-numb3rs-symbols"
assert truncate("abcdef", 4) == "abc…"
assert title_case("hello world") == "Hello World"
print("T3 ok")
`,
    },
  },
  {
    id: "refactor-extract",
    title: "Extract the duplicated line formatting in report.py",
    turns: [
      "report.py formats report lines in two places with duplicated logic. Refactor: extract a single helper function format_line(label, value, width) used by both render_summary and render_details. Behavior must stay exactly the same (the check script verifies the outputs).",
    ],
    chatFiles: ["report.py"],
    files: {
      "report.py": `def render_summary(rows):
    """Render (label, value) rows as aligned 'label: value' lines."""
    lines = []
    for label, value in rows:
        text = str(value)
        lines.append(f"{label:<12}: {text}")
    return "\\n".join(lines)


def render_details(rows):
    """Render (label, value) rows as aligned 'label: value' lines with a bullet."""
    lines = []
    for label, value in rows:
        text = str(value)
        lines.append(f"- {label:<12}: {text}")
    return "\\n".join(lines)
`,
      "check.py": `import re
import report

out = report.render_summary([("cpu", "0.42"), ("memory", "0.87")])
assert out == "cpu         : 0.42\\nmemory      : 0.87", repr(out)

det = report.render_details([("cpu", "0.42"), ("memory", "0.87")])
assert det == "- cpu         : 0.42\\n- memory      : 0.87", repr(det)

source = open("report.py").read()
# A shared helper must exist and both renderers must call it.
helper = re.search(r"def (format_line|_format_line|make_line)\\(", source)
assert helper is not None, "no shared helper found"
calls = source.count(f"{helper.group(1)}(")
assert calls >= 3, f"helper defined but not used by both renderers ({calls} calls)"
print("T4 ok")
`,
    },
  },
  {
    id: "multi-turn",
    title: "Build up pipeline.py across four turns",
    turns: [
      "Create parse_ranges(text) in pipeline.py: given a string like '1-3,5,7-9', return the list of covered integers [1,2,3,5,7,8,9]. Handle whitespace around items and around the hyphen (so ' 1 - 3 , 10 ' parses as [1,2,3,10]). Invalid items can be ignored for now.",
      "Now harden parse_ranges: if any single item is not a valid range or integer (after stripping), raise ValueError with a message that includes the offending item.",
      "Add summarize_ranges(numbers) to pipeline.py: given a sorted list of unique integers, return the compact range string (e.g. [1,2,3,5,7,8,9] -> '1-3,5,7-9'). Consecutive single integers stay single ('4' not '4-4').",
      "Add a module-level docstring to pipeline.py briefly describing the two functions, and make summarize_ranges return an empty string for an empty list instead of raising.",
    ],
    chatFiles: ["pipeline.py"],
    files: {
      "pipeline.py": `# Range utilities for the data pipeline (grows over several turns).
`,
      "check.py": `from pipeline import parse_ranges, summarize_ranges

assert parse_ranges("1-3,5,7-9") == [1, 2, 3, 5, 7, 8, 9]
assert parse_ranges(" 1 - 3 , 10 ") == [1, 2, 3, 10]
try:
    parse_ranges("1-3,x,7")
    raise SystemExit("expected ValueError for invalid item")
except ValueError as err:
    assert "x" in str(err)

assert summarize_ranges([1, 2, 3, 5, 7, 8, 9]) == "1-3,5,7-9"
assert summarize_ranges([4]) == "4"
assert summarize_ranges([]) == ""

doc = open("pipeline.py").read()
assert doc.strip().startswith('"""'), "module docstring missing"
print("T5 ok")
`,
    },
  },
];

/** The corpus's declared turn count (battery telemetry). */
export const CORPUS_TURN_COUNT = CODING_CORPUS.reduce(
  (total, task) => total + task.turns.length,
  0,
);
