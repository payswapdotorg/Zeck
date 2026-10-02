/**
 * Supply rate-limit boundary probe for PPR-022 (diagnostic only — never part
 * of the battery's proof surface). Re-creation of the tool lost to the
 * 2026-09-30T19:36Z sandbox rebuild: sends ONE minimal chat-completion
 * request through the identical supply-config loader the battery's
 * requireHealthySupply() gate uses, and prints ONLY the rate-limit response
 * headers (the four public counters). Credential material is never logged.
 */
import { loadZaiSupplyConfig } from "./zai-config";

async function main(): Promise<void> {
  const supply = loadZaiSupplyConfig();
  const base = supply.baseUrl.replace(/\/+$/, "");
  const startedAt = new Date();
  try {
    const probe = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: supply.authHeaders,
      body: JSON.stringify({
        model: "glm-4-plus",
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const interesting = [
      "x-ratelimit-user-10min-limit",
      "x-ratelimit-user-10min-remaining",
      "x-ratelimit-user-daily-limit",
      "x-ratelimit-user-daily-remaining",
      "retry-after",
      "x-ratelimit-reset",
      "x-ratelimit-reset-requests",
    ] as const;
    console.log(`probe at ${startedAt.toISOString()} -> HTTP ${probe.status}`);
    for (const key of interesting) {
      console.log(`  ${key}: ${probe.headers.get(key) ?? "(absent)"}`);
    }
    if (probe.status !== 200) {
      const body = (await probe.text()).slice(0, 400);
      console.log(`  body: ${body.replace(/\s+/g, " ")}`);
    }
  } catch (error) {
    console.log(`probe at ${startedAt.toISOString()} -> transport failure: ${String(error)}`);
  }
}

void main();
