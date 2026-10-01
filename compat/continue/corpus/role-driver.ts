#!/usr/bin/env bun
/**
 * The PPR-021 corpus role driver — runs ONE representative IDE-role task
 * through the PINNED, UNMODIFIED Continue core (the shared engine every
 * IDE client drives through the core protocol) inside the certified
 * proof environment (egress-deny preload + credential-scrubbed
 * allowlist environment + CONTINUE_GLOBAL_DIR isolation with the
 * role-model config.yaml).
 *
 * This file is PROOF-HARNESS GLUE (the Zeck repository's compat
 * surface), not Continue code: it configures the pinned application
 * runtime through Continue's OWN public configuration surface (the
 * isolated config.yaml whose role models point at the local Zeck
 * adapter) and drives the SAME core functions the IDE clients drive
 * through the core protocol handlers:
 *
 *  - edit:      core/edit/streamDiffLines.ts streamDiffLines(payload
 *               type "edit") — the exact path the core.ts
 *               "streamDiffLines" handler drives for the IDE's Cmd+K
 *               edit flow;
 *  - apply:     the same streamDiffLines with payload type "apply" —
 *               the fast-apply path;
 *  - autocomplete: core/autocomplete/CompletionProvider.ts
 *               provideInlineCompletionItems — the exact construction
 *               core.ts uses (the "autocomplete/complete" handler);
 *  - embed:     BaseLLM.embed over the embed-role model — the exact
 *               call core/indexing/CodebaseIndexer.ts makes per chunk;
 *  - rerank:    BaseLLM.rerank over the rerank-role model — the exact
 *               call core/context/retrieval/pipelines/
 *               RerankerRetrievalPipeline.ts makes.
 *
 * No Continue file is forked, patched or shimmed, and nothing here
 * teaches Continue about Zeck: the ONLY thing it hands the runtime is
 * an OpenAI-compatible base URL (the local Zeck adapter) and the
 * literal placeholder api key the client-side shape check requires.
 *
 * ONE runtime-environment accommodation (documented honestly): the
 * harness process runs under Bun, whose ReadableStream lacks the static
 * `.from()` the pinned Continue's packages/fetch stream shim relies on
 * (a Node-20 API; observed live: "ReadableStream.from is not a
 * function" breaking the legacy-completions stream path for the
 * autocomplete/edit/apply roles). The polyfill below installs the
 * missing STATIC constructor on the GLOBAL ReadableStream BEFORE any
 * Continue module loads — it adds the platform API the app expects,
 * exactly like the egress preload patches fetch; it does not touch any
 * Continue code or behavior.
 *
 * Usage (from the Zeck-side corpus runner, under the egress preload):
 *   bun role-driver.ts <task-spec.json>
 *
 * The task spec (JSON):
 *   {
 *     "task_id": "...",
 *     "workspace": "/abs/path",       // the task's fresh workspace
 *     "home": "/abs/path",            // CONTINUE_GLOBAL_DIR (isolated)
 *     "continue_root": "/abs/path",   // the pinned Continue checkout
 *     "action": "edit" | "apply" | "autocomplete" | "embed" | "rerank",
 *     ...action-specific fields below
 *   }
 *
 * Output: a single JSON object on the LAST stdout line:
 *   CONTINUE_ROLE_RESULT:{"ok":true|false,"blocked":bool,"error":str|null,
 *                          "detail":str,"artifact":{...}|null}
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The platform-API polyfill (see the header note): Bun's ReadableStream has
// no static .from() (Node ≥20) while the pinned Continue's
// packages/fetch/dist/stream.js streamResponse() calls
// ReadableStream.from(response.body) on the legacy-completions stream path
// (autocomplete FIM + the edit/apply streamDiffLines prompt path). Install
// the missing static before ANY Continue module loads. The polyfill accepts
// an async-iterable body (what a fetch Response body is) and adapts it to
// the ReadableStream the shim iterates — a pure platform-shape addition.
// ---------------------------------------------------------------------------
{
  const rs = ReadableStream as unknown as { from?: (body: unknown) => ReadableStream };
  if (typeof rs.from !== "function") {
    rs.from = (body: unknown): ReadableStream => {
      const iterator = (body as AsyncIterable<Uint8Array> | undefined)?.[Symbol.asyncIterator];
      if (iterator === undefined) {
        throw new TypeError("ReadableStream.from polyfill: body is not async-iterable");
      }
      const it = iterator.call(body as AsyncIterable<Uint8Array>);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const step = await it.next();
          if (step.done === true) {
            controller.close();
          } else {
            controller.enqueue(step.value);
          }
        },
        async cancel() {
          await it.return?.();
        },
      });
    };
  }
}

interface TaskSpec {
  readonly task_id: string;
  readonly workspace: string;
  readonly home: string;
  readonly continue_root: string;
  readonly action: "edit" | "apply" | "autocomplete" | "embed" | "rerank";
  readonly file?: string;
  // edit/apply
  readonly instruction?: string;
  readonly new_code?: string;
  readonly range_start?: { line: number; character: number };
  readonly range_end?: { line: number; character: number };
  // autocomplete
  readonly position?: { line: number; character: number };
  // embed
  readonly embed_inputs?: readonly string[];
  // rerank
  readonly query?: string;
  readonly documents?: readonly string[];
}

function emit(payload: Record<string, unknown>): void {
  console.log(`CONTINUE_ROLE_RESULT:${JSON.stringify(payload)}`);
}

async function main(): Promise<void> {
  const specPath = process.argv[2] ?? "";
  if (specPath.length === 0) {
    emit({ ok: false, blocked: false, error: "no task spec path", detail: "", artifact: null });
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as TaskSpec;
  process.env.CONTINUE_GLOBAL_DIR = spec.home;

  const coreRoot = join(spec.continue_root, "core");
  const { pathToFileURL } = await import("node:url");
  const filesystemMod = await import(join(coreRoot, "util", "filesystem.js"));
  const FileSystemIde = filesystemMod.default;

  /**
   * A URI-returning FileSystemIde (the IDE interface contract the
   * vscode/jetbrains IDEs follow — getWorkspaceDirs returns file://
   * URIs). The headless proof IDE additionally reports a non-vscode
   * ideType so Continue's own vscode-only transformers.js local
   * embeddings provider is not auto-added to the embed role (a
   * disclosed config gate — the embed role resolves solely to the
   * declared delegated model).
   */
  class ProofIde extends FileSystemIde {
    /**
     * The untyped (dynamically imported) base takes the workspace
     * directory (core/util/filesystem.ts:23); the explicit passthrough
     * keeps the construct signature under TypeScript's any-base
     * synthesis.
     */
    constructor(workspaceDir: string) {
      super(workspaceDir);
    }
    async getWorkspaceDirs(): Promise<string[]> {
      return [pathToFileURL(this.workspaceDir).href];
    }
    async getIdeInfo(): Promise<{ ideType: string; name: string; version: string; remoteName: string; extensionVersion: string; isPrerelease: boolean }> {
      return {
        ideType: "jetbrains",
        name: "ppr-021-headless-proof",
        version: "0.1",
        remoteName: "na",
        extensionVersion: "na",
        isPrerelease: false,
      };
    }
  }

  const ide = new ProofIde(spec.workspace);
  const { ConfigHandler } = await import(join(coreRoot, "config", "ConfigHandler.js"));
  const { LLMLogger } = await import(join(coreRoot, "llm", "logger.js"));
  const handler = new ConfigHandler(ide, new LLMLogger());
  const { config, errors } = await handler.loadConfig();
  if (!config) {
    emit({
      ok: false,
      blocked: false,
      error: `config load failed: ${JSON.stringify(errors ?? []).slice(0, 300)}`,
      detail: "",
      artifact: null,
    });
    process.exit(1);
  }
  const roleModel = (role: "chat" | "edit" | "apply" | "embed" | "rerank") =>
    config.selectedModelByRole[role] ??
    (config.modelsByRole[role][0] ?? null);

  if (spec.action === "edit" || spec.action === "apply") {
    const { streamDiffLines } = await import(join(coreRoot, "edit", "streamDiffLines.js"));
    const llm =
      spec.action === "edit"
        ? (roleModel("edit") ?? roleModel("chat"))
        : (roleModel("apply") ?? roleModel("chat"));
    if (llm === null) {
      emit({ ok: false, blocked: false, error: `no ${spec.action}-role model`, detail: "", artifact: null });
      process.exit(1);
    }
    const file = join(spec.workspace, spec.file ?? "");
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    const startLine = spec.range_start?.line ?? 0;
    const endLine = spec.range_end?.line ?? lines.length;
    const prefix = lines.slice(0, startLine).join("\n");
    const highlighted = lines.slice(startLine, endLine).join("\n");
    const suffix = lines.slice(endLine).join("\n");
    const language = (spec.file ?? "").split(".").pop() ?? "";
    const payload =
      spec.action === "edit"
        ? {
            type: "edit" as const,
            prefix,
            highlighted,
            suffix,
            input: spec.instruction ?? "",
            language,
            modelTitle: llm.title ?? undefined,
            includeRulesInSystemMessage: false,
          }
        : {
            type: "apply" as const,
            prefix,
            highlighted,
            suffix,
            input: "",
            language,
            modelTitle: llm.title ?? undefined,
            includeRulesInSystemMessage: false,
            newCode: spec.new_code ?? "",
          };
    const abortController = new AbortController();
    const diffLines: { type: string; line: string }[] = [];
    for await (const diffLine of streamDiffLines(payload, llm, abortController, undefined, config.rules)) {
      diffLines.push({ type: diffLine.type, line: diffLine.line });
    }
    // Apply the streamed diff (the mechanical step the IDE performs on
    // the editor buffer). streamDiff(oldLines, lines) diffs ONLY the
    // highlighted range against the model's output — the yielded
    // same/old/new lines are the RANGE's replacement, and the IDE
    // reassembles the buffer as prefix + applied-range + suffix (the
    // prefix/suffix are not part of the yielded diff — observed live:
    // writing only the diff lines dropped the file's tail).
    let rangeContent = "";
    for (const diffLine of diffLines) {
      if (diffLine.type === "old") {
        continue;
      }
      rangeContent += diffLine.line;
      rangeContent += "\n";
    }
    // streamDiffLines emits full lines; strip the trailing join artifact
    if (rangeContent.endsWith("\n")) {
      rangeContent = rangeContent.slice(0, -1);
    }
    const reassemble = (before: string, middle: string, after: string): string => {
      const parts: string[] = [];
      if (before.length > 0) parts.push(before);
      if (middle.length > 0) parts.push(middle);
      if (after.length > 0) parts.push(after);
      return parts.join("\n");
    };
    const newContent = reassemble(prefix, rangeContent, suffix);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, newContent, "utf8");
    emit({
      ok: true,
      blocked: false,
      error: null,
      detail: `${spec.action} stream produced ${diffLines.length} diff line(s) over ${spec.file}`,
      artifact: { file: spec.file ?? "", newLines: newContent.split("\n").length },
    });
    process.exit(0);
  }

  if (spec.action === "autocomplete") {
    const { CompletionProvider } = await import(join(coreRoot, "autocomplete", "CompletionProvider.js"));
    const getLlm = async () => {
      const { config: fresh } = await handler.loadConfig();
      if (!fresh) {
        return undefined;
      }
      return fresh.selectedModelByRole.autocomplete ?? undefined;
    };
    const provider = new CompletionProvider(
      handler,
      ide,
      getLlm,
      () => {},
      (..._args: unknown[]) => Promise.resolve([]),
    );
    const filepath = join(spec.workspace, spec.file ?? "");
    const { pathToFileURL: toUri } = await import("node:url");
    const outcome = await provider.provideInlineCompletionItems(
      {
        isUntitledFile: false,
        completionId: `ppr-021-${spec.task_id}`,
        filepath: toUri(filepath).href,
        pos: spec.position ?? { line: 0, character: 0 },
        recentlyVisitedRanges: [],
        recentlyEditedRanges: [],
      },
      undefined,
    );
    emit({
      ok: outcome !== undefined,
      blocked: false,
      error: outcome === undefined ? "no completion produced" : null,
      detail:
        outcome === undefined
          ? "CompletionProvider returned undefined"
          : `completion produced (${outcome.completion.length} chars, model ${outcome.modelName})`,
      artifact: outcome === undefined ? null : { completion: outcome.completion },
    });
    process.exit(0);
  }

  if (spec.action === "embed") {
    const llm = roleModel("embed");
    if (llm === null) {
      emit({ ok: false, blocked: false, error: "no embed-role model", detail: "", artifact: null });
      process.exit(1);
    }
    const inputs = spec.embed_inputs ?? [];
    try {
      const vectors = await llm.embed(inputs);
      emit({
        ok: true,
        blocked: false,
        error: null,
        detail: `embed returned ${vectors.length} vector(s)`,
        artifact: { count: vectors.length, dimensions: vectors[0]?.length ?? 0 },
      });
      process.exit(0);
    } catch (error) {
      // The honest delegated failure (the rail's provider-unavailable
      // for the embeddings surface) — surfaced as BLOCKED, never faked.
      emit({
        ok: false,
        blocked: true,
        error: error instanceof Error ? error.message : String(error),
        detail: "the delegated embeddings execution failed at the supply boundary",
        artifact: null,
      });
      process.exit(0);
    }
  }

  if (spec.action === "rerank") {
    const llm = roleModel("rerank");
    if (llm === null) {
      emit({ ok: false, blocked: false, error: "no rerank-role model", detail: "", artifact: null });
      process.exit(1);
    }
    const documents = spec.documents ?? [];
    const chunks = documents.map((content, index) => ({
      content,
      digest: `ppr-021-doc-${index}`,
      filepath: `doc-${index}.txt`,
      index,
      startLine: 0,
      endLine: 0,
      otherMetadata: undefined,
    }));
    const scores = await llm.rerank(spec.query ?? "", chunks);
    emit({
      ok: true,
      blocked: false,
      error: null,
      detail: `rerank returned ${scores.length} score(s)`,
      artifact: { scores },
    });
    process.exit(0);
  }

  emit({ ok: false, blocked: false, error: `unknown action ${spec.action}`, detail: "", artifact: null });
  process.exit(1);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  emit({
    ok: false,
    blocked: false,
    error: error instanceof Error ? error.message : String(error),
    detail: "",
    artifact: null,
  });
  process.exit(1);
}
