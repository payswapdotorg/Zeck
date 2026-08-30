/**
 * Stage 5 — Structural compilation (context module; WORK-008 / CTX-001).
 *
 * Assembles the final task context as ordered SECTIONS with fully
 * referenced items: a `task` section carrying the directive provenance
 * (bound to the consuming execution) and a `sources` section carrying
 * every surviving compressed item with its source reference. Section and
 * item order is fully deterministic (incoming ranked order).
 */

import type { SourceReference } from "../../../artifacts/public";
import type { ExecutionConsumptionRef } from "../manifest";
import type { CompressedItem } from "./compression";

export interface ContextTaskDescriptor {
  readonly summary: string;
  readonly keywords?: readonly string[];
}

export interface StructureStageInput {
  readonly task: ContextTaskDescriptor;
  readonly applicationId: string;
  readonly execution: ExecutionConsumptionRef;
  readonly items: readonly CompressedItem[];
}

export interface StructuredItem {
  readonly sourceRef: SourceReference;
  readonly title: string;
  readonly content: string;
}

export interface TaskContextSection {
  readonly id: "task" | "sources";
  readonly items: readonly StructuredItem[];
}

export interface CompiledTaskContext {
  readonly sections: readonly TaskContextSection[];
}

export function applyStructureStage(input: StructureStageInput): CompiledTaskContext {
  const taskSection: TaskContextSection = {
    id: "task",
    items: [
      {
        sourceRef: {
          kind: "request",
          id: input.execution.executionId,
          locator: input.applicationId,
        },
        title: "task-directive",
        content: input.task.summary,
      },
    ],
  };
  const sourcesSection: TaskContextSection = {
    id: "sources",
    items: input.items.map((item) => ({
      sourceRef: { kind: "source", id: item.sourceId, locator: item.locator } as SourceReference,
      title: item.title,
      content: item.content,
    })),
  };
  return { sections: [taskSection, sourcesSection] };
}
