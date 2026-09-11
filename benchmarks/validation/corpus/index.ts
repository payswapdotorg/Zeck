/**
 * The golden corpus assembly (VAL-003, acceptance criteria 2, 6, 8).
 *
 * The corpus is the union of all scenario families — assembled
 * DETERMINISTICALLY (pure module composition, no environment, no
 * randomness): the same corpus version always yields the same task
 * set with the same identities. Corpus growth is APPEND-ONLY: new
 * rows and new scenarios extend the corpus; historical task identities
 * never change or disappear (a removed scenario is a corpus MAJOR
 * version — a documented, reviewable event that invalidates runs and
 * must be justified to the Architect).
 */

import type { RunMetadata } from "../run-identity";
import { audioUnderstandingScenarios } from "./families/audio-understanding";
import { browserUseScenarios } from "./families/browser-use";
import { codingScenarios } from "./families/coding";
import { computerUseScenarios } from "./families/computer-use";
import { customerServiceScenarios } from "./families/customer-service";
import { hitlScenarios } from "./families/hitl";
import { imageGenerationScenarios } from "./families/image-generation";
import { imageRecognitionScenarios } from "./families/image-recognition";
import { longRunningScenarios } from "./families/long-running";
import { multimodalScenarios } from "./families/multimodal";
import { operationsScenarios } from "./families/operations";
import { ragScenarios } from "./families/rag";
import { realtimeVoiceScenarios } from "./families/realtime-voice";
import { researchScenarios } from "./families/research";
import { structuredScenarios } from "./families/structured";
import { textScenarios } from "./families/text";
import { threeDScenarios } from "./families/three-d";
import { toolsScenarios } from "./families/tools";
import { videoMediaScenarios } from "./families/video-media";
import { vlmScenarios } from "./families/vlm";
import { voiceScenarios } from "./families/voice";
import { workflowScenarios } from "./families/workflow";
import type { GoldenTask, WorkloadFamily } from "./schema";
import { WORKLOAD_FAMILIES } from "./schema";

/** The corpus version (append-only growth bumps the minor digit). */
export const CORPUS_VERSION = "val-corpus.1.0.0";

/** The scenario families, in stable registry order. */
export const SCENARIO_FAMILIES = [
  ...textScenarios,
  ...structuredScenarios,
  ...ragScenarios,
  ...toolsScenarios,
  ...workflowScenarios,
  ...longRunningScenarios,
  ...voiceScenarios,
  ...realtimeVoiceScenarios,
  ...imageGenerationScenarios,
  ...videoMediaScenarios,
  ...imageRecognitionScenarios,
  ...vlmScenarios,
  ...audioUnderstandingScenarios,
  ...multimodalScenarios,
  ...threeDScenarios,
  ...customerServiceScenarios,
  ...browserUseScenarios,
  ...computerUseScenarios,
  ...researchScenarios,
  ...codingScenarios,
  ...operationsScenarios,
  ...hitlScenarios,
];

/** Every golden task in the corpus (deterministic assembly). */
export const GOLDEN_TASKS: readonly GoldenTask[] = SCENARIO_FAMILIES.flat();

/** Look up a task by its stable identity. */
export function taskById(taskId: string): GoldenTask | undefined {
  return GOLDEN_TASKS.find((task) => task.taskId === taskId);
}

/** All tasks of one workload family. */
export function tasksByFamily(family: WorkloadFamily): readonly GoldenTask[] {
  return GOLDEN_TASKS.filter((task) => task.family === family);
}

/** The per-family task counts (the corpus coverage snapshot). */
export function familyTaskCounts(): Readonly<Record<WorkloadFamily, number>> {
  const counts = {} as Record<WorkloadFamily, number>;
  for (const family of WORKLOAD_FAMILIES) {
    counts[family] = tasksByFamily(family).length;
  }
  return counts;
}

/** The corpus's documented per-family floor (the roadmap's ~20 minimum). */
export const FAMILY_TASK_FLOOR = 20;

/**
 * Build the run metadata inputs for one corpus task (criterion 6:
 * corpus version and task identities are part of run metadata —
 * wired into VAL-001's run-identity contract).
 */
export function runMetadataForTask(
  task: GoldenTask,
  input: {
    readonly baseRevision: string;
    readonly applicationRevision: string;
    readonly integrationSurface: string;
    readonly environment: RunMetadata["environment"];
    readonly observedAt: string;
  },
): RunMetadata {
  return {
    program: "zeck-validation",
    workOrder: task.family,
    baseRevision: input.baseRevision,
    applicationRevision: input.applicationRevision,
    corpusRevision: CORPUS_VERSION,
    integrationSurface: input.integrationSurface,
    environment: {
      ...input.environment,
      configuration: {
        ...input.environment.configuration,
        corpusTask: task.taskId,
        corpusScenario: task.scenarioId,
      },
    },
    observedAt: input.observedAt,
  };
}
