/**
 * The PPR-024 composition smoke test — verifies the full two-plane proof
 * stack composes and the minimal paths work before the battery runs:
 *   1. the proof stack (world + gateway + rail + substrate driver + adapter);
 *   2. a chat completion through the adapter (model plane → GLM supply);
 *   3. a substrate session open + state extraction + close through the
 *      adapter (actuation plane → the pinned runtime's own BrowserSession
 *      over the real Chromium);
 *   4. the deny-proxy egress canary from a real Python httpx client.
 *
 * NOT a proof: a composition check (the battery is the proof).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { composeProofStack } from "./compose";
import { createEgressProxy } from "./egress-proxy";
import {
  REVEAL_BUTTON_TEXT,
  REVEAL_TOKEN,
  REVEAL_TOKEN_MARKER,
} from "../corpus/tasks";
import { createRevealTokenPage, FIXTURE_PAGE_PORT } from "./fixture-page";

async function main(): Promise<void> {
  mkdirSync("/tmp/ppr-024-smoke", { recursive: true });
  const proxy = await createEgressProxy();
  const fixture = createRevealTokenPage({
    port: FIXTURE_PAGE_PORT,
    token: REVEAL_TOKEN,
    buttonText: REVEAL_BUTTON_TEXT,
    tokenMarker: REVEAL_TOKEN_MARKER,
  });
  console.log("[smoke] fixture page:", fixture.url);
  console.log("[smoke] deny proxy:", proxy.url);

  const stack = await composeProofStack({
    substrateProxyServer: proxy.url,
    substrateProxyBypass: "127.0.0.1,localhost",
    minDispatchIntervalMs: 500,
  });
  try {
    console.log("[smoke] stack composed; adapter:", stack.adapter.url);

    // ---- model plane: one chat completion through the adapter ----
    const chat = await fetch(`${stack.adapter.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-4-plus",
        messages: [{ role: "user", content: 'Return the JSON {"ok": true} and nothing else.' }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "probe",
            strict: true,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
        temperature: 0,
      }),
    });
    const chatBody = (await chat.json()) as Record<string, unknown>;
    console.log("[smoke] chat status:", chat.status, "content:", JSON.stringify(chatBody).slice(0, 220));

    // ---- actuation plane: substrate session open → state → close ----
    const open = await fetch(`${stack.adapter.url}/substrate/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "open", profile: { headless: true } }),
    });
    const openBody = (await open.json()) as Record<string, unknown>;
    console.log("[smoke] substrate open status:", open.status, JSON.stringify(openBody).slice(0, 200));
    const sessionId = ((openBody.result ?? {}) as Record<string, unknown>).substrateSessionId as string;

    const nav = await fetch(`${stack.adapter.url}/substrate/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, action: { navigate: { url: fixture.url } } }),
    });
    const navBody = (await nav.json()) as Record<string, unknown>;
    console.log("[smoke] navigate status:", nav.status, JSON.stringify(navBody).slice(0, 300));

    const state = await fetch(`${stack.adapter.url}/substrate/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, includeScreenshot: false, cached: false, includeRecentEvents: false }),
    });
    const stateBody = (await state.json()) as Record<string, unknown>;
    const stateResult = (stateBody.result ?? {}) as Record<string, unknown>;
    console.log("[smoke] state status:", state.status, "url:", stateResult.url, "selectorMapSize:", stateResult.selectorMapSize);
    const domRepr = String(((stateResult.state ?? {}) as Record<string, unknown>).domLlmRepresentation ?? "");
    console.log("[smoke] dom repr head:", domRepr.slice(0, 200).replace(/\n/g, " | "));

    const close = await fetch(`${stack.adapter.url}/substrate/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "close", sessionId }),
    });
    console.log("[smoke] close status:", close.status);

    console.log("[smoke] rail facts:", stack.railFacts().length, "substrate facts:", stack.substrateFacts().length);
    console.log("[smoke] egress violations:", proxy.violations().length);
    for (const log of stack.adapter.requests()) {
      console.log(
        `[smoke] adapter ${log.surface} ${log.edgeId} exec=${log.executionId.slice(0, 18)}… terminal=${log.terminal}`,
      );
    }
  } finally {
    await stack.close();
    fixture.close();
    proxy.close();
  }
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error);
  process.exitCode = 1;
});
