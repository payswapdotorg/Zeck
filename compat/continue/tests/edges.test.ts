/**
 * PPR-021 adapter attribution tests — the deterministic
 * (endpoint, role-model) → edge mapping, pinned.
 */

import { describe, expect, it } from "vitest";
import {
  attributeEdge,
  CONTINUE_ROLE_MODELS,
  SURFACE_TASK_KINDS,
} from "../adapter/edges";
import { renderContinueConfigYaml, ZECK_ADAPTER_API_KEY_PLACEHOLDER } from "../corpus/config";

describe("the (surface, role model) → edge attribution", () => {
  it("attributes every role model on its wire surface to the declared edge", () => {
    expect(attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.chat })).toEqual({
      edgeId: "continue.cli.agent-loop.chat",
      role: "main",
      signals: ["surface:chat-completions", "role-model:chat"],
    });
    expect(
      attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.subagent })?.edgeId,
    ).toBe("continue.cli.subagent.child-session");
    // The edit/apply roles ride the LEGACY text-completions endpoint (the
    // pinned runtime's streamDiffLines → streamComplete path — observed
    // live at proof time: the requests arrive on /v1/completions), NOT
    // the chat-completions surface.
    expect(
      attributeEdge({ surface: "completions", model: CONTINUE_ROLE_MODELS.edit })?.edgeId,
    ).toBe("continue.core.edit.inline-edit");
    expect(
      attributeEdge({ surface: "completions", model: CONTINUE_ROLE_MODELS.apply })?.edgeId,
    ).toBe("continue.core.apply.fast-apply");
    expect(attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.edit })).toBeNull();
    expect(attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.apply })).toBeNull();
    expect(
      attributeEdge({ surface: "completions", model: CONTINUE_ROLE_MODELS.autocomplete })?.edgeId,
    ).toBe("continue.core.autocomplete.tab");
    expect(attributeEdge({ surface: "embeddings", model: CONTINUE_ROLE_MODELS.embed })?.edgeId).toBe(
      "continue.core.indexing.embed",
    );
    expect(attributeEdge({ surface: "rerank", model: CONTINUE_ROLE_MODELS.rerank })?.edgeId).toBe(
      "continue.core.retrieval.rerank",
    );
  });

  it("marks the auxiliary role models as auxiliary (the subagent/edit/apply/embed/rerank edges)", () => {
    expect(
      attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.subagent })?.role,
    ).toBe("auxiliary");
    expect(attributeEdge({ surface: "embeddings", model: CONTINUE_ROLE_MODELS.embed })?.role).toBe(
      "auxiliary",
    );
    expect(attributeEdge({ surface: "rerank", model: CONTINUE_ROLE_MODELS.rerank })?.role).toBe(
      "auxiliary",
    );
    expect(
      attributeEdge({ surface: "chat/completions", model: CONTINUE_ROLE_MODELS.chat })?.role,
    ).toBe("main");
  });

  it("returns null for an unknown model (never a guessed attribution)", () => {
    expect(attributeEdge({ surface: "chat/completions", model: "gpt-4o" })).toBeNull();
    expect(attributeEdge({ surface: "embeddings", model: CONTINUE_ROLE_MODELS.chat })).toBeNull();
    expect(attributeEdge({ surface: "rerank", model: "unknown-reranker" })).toBeNull();
  });

  it("maps every surface to its rail task kind", () => {
    expect(SURFACE_TASK_KINDS["chat/completions"]).toBe("continue-role.chat-completions");
    expect(SURFACE_TASK_KINDS.completions).toBe("continue-role.completions");
    expect(SURFACE_TASK_KINDS.embeddings).toBe("continue-role.embeddings");
    expect(SURFACE_TASK_KINDS.rerank).toBe("continue-role.rerank");
  });
});

describe("the seeded role-model config.yaml", () => {
  it("declares every role model at the adapter with the placeholder key (never a credential)", () => {
    const yaml = renderContinueConfigYaml("http://127.0.0.1:43210/v1");
    for (const model of Object.values(CONTINUE_ROLE_MODELS)) {
      expect(yaml).toContain(`model: ${model}`);
    }
    expect(yaml).toContain("provider: openai");
    expect(yaml).toContain("apiBase: http://127.0.0.1:43210/v1/");
    expect(yaml).toContain(`apiKey: "${ZECK_ADAPTER_API_KEY_PLACEHOLDER}"`);
    // Every role is declared:
    for (const role of ["chat", "subagent", "edit", "apply", "autocomplete", "embed", "rerank"]) {
      expect(yaml).toContain(role);
    }
    // The subagent definition carries the CLI's own availability rule
    // (role subagent + chatOptions.baseSystemMessage):
    expect(yaml).toContain("baseSystemMessage");
  });

  it("carries NO provider host anywhere in the certified-arm config", () => {
    const yaml = renderContinueConfigYaml("http://127.0.0.1:43210/v1");
    expect(yaml).not.toContain("api.openai.com");
    expect(yaml).not.toContain("internal-api.z.ai");
    expect(yaml).not.toContain("api.continue.dev");
  });
});
