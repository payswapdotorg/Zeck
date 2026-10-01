/**
 * The PPR-022 multi-surface probe — one quick run per remaining declared
 * surface (vision-analyze, TTS, STT, image generation) through the
 * composed proof stack, to validate each surface's wiring before the
 * full battery. Development-time tooling only.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { composeProofStack } from "../harness/compose";
import { createAdapterServer } from "../adapter/server";
import { createEgressProxy } from "../harness/egress-proxy";
import { runMediaDriver, runOneShot, writeHermesConfig } from "../harness/corpus-runner";
import {
  CORPUS_TASKS,
  DUPLICATE_PROBE_TASK,
  VISION_SWATCH_PATH,
} from "../corpus/tasks";

async function main(): Promise<void> {
  const root = "/tmp/ppr-022-surfaces";
  rmSync(root, { recursive: true, force: true });

  const stack = await composeProofStack({ minDispatchIntervalMs: 800, retryCooldownMs: 4000 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const proxy = await createEgressProxy();
  console.log(`adapter=${adapter.url} proxy=${proxy.url}`);

  const setup = (taskId: string) => {
    const work = join(root, taskId, "work");
    const home = join(root, taskId, "home");
    mkdirSync(work, { recursive: true });
    mkdirSync(home, { recursive: true });
    const task = [...CORPUS_TASKS, DUPLICATE_PROBE_TASK].find((t) => t.taskId === taskId);
    if (task === undefined) {
      throw new Error(`unknown probe task ${taskId}`);
    }
    task.fixture(work);
    writeHermesConfig(home, adapter.url, task);
    return { work, home, task };
  };

  // 1. vision-qa
  {
    const { work, home } = setup("vision-qa");
    const result = await runOneShot(
      { proxy, runTimeoutMs: 240_000 },
      work,
      home,
      "Use the vision_analyze tool on the local file orange-swatch.png and answer: " +
        "what is the dominant color? Reply with just the color name.",
      "vision",
    );
    console.log(`[vision] exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(-200))}`);
    console.log(`[vision] stderr tail=${result.stderr.slice(-400).replace(/\n/g, " ")}`);
  }

  // 2. speak-text (TTS)
  {
    const { work, home } = setup("speak-text");
    const result = await runOneShot(
      { proxy, runTimeoutMs: 240_000 },
      work,
      home,
      "Use the text_to_speech tool to synthesize exactly this text: 'Surface probe " +
        "complete.' Save it with output_path 'spoken.wav'. Confirm when done.",
      "tts",
    );
    console.log(`[tts] exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(-200))}`);
    console.log(`[tts] stderr tail=${result.stderr.slice(-400).replace(/\n/g, " ")}`);
    const candidates = [join(work, "spoken.wav"), join(home, "voice-memos", "spoken.wav")];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        console.log(`[tts] artifact ${candidate} (${readFileSync(candidate).length} bytes)`);
      }
    }
  }

  // 3. transcribe-memo (STT through the media driver)
  {
    const { work, home } = setup("transcribe-memo");
    const result = await runMediaDriver(
      { proxy, runTimeoutMs: 240_000 },
      work,
      home,
      join(work, "voice-memo.wav"),
    );
    console.log(`[stt] exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(-300))}`);
    console.log(`[stt] stderr tail=${result.stderr.slice(-400).replace(/\n/g, " ")}`);
  }

  // 4. generate-image
  {
    const { work, home } = setup("generate-image");
    const result = await runOneShot(
      { proxy, runTimeoutMs: 300_000 },
      work,
      home,
      "Use the image_generate tool to create an image with the prompt 'a flat minimal vector " +
        "icon of a single teal circle on white background', square aspect ratio. Report the saved path.",
      "image_gen",
    );
    console.log(`[image] exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(-300))}`);
    console.log(`[image] stderr tail=${result.stderr.slice(-400).replace(/\n/g, " ")}`);
    const imagesDir = join(home, "cache", "images");
    if (existsSync(imagesDir)) {
      for (const name of require("node:fs").readdirSync(imagesDir) as string[]) {
        console.log(`[image] artifact ${join(imagesDir, name)} (${readFileSync(join(imagesDir, name)).length} bytes)`);
      }
    }
  }

  console.log("=== adapter logs ===");
  for (const log of adapter.requests()) {
    console.log(
      `${log.surface} ${log.edgeId} -> ${log.executionId} terminal=${log.terminal} replayed=${log.replayed} chars=${log.contentChars} tools=${log.toolCallCount}`,
    );
  }
  console.log("=== egress violations ===", proxy.violations().length);
  for (const violation of proxy.violations()) {
    console.log(`  ${violation.host}: ${violation.rule} (blocked=${violation.blocked})`);
  }

  adapter.close();
  proxy.close();
  await stack.close();
}

main().catch((error) => {
  console.error("PROBE FAILED:", error);
  process.exit(1);
});
