/**
 * Direct adapter-surface probe — POSTs straight to the adapter's media
 * endpoints (speech, transcriptions, images) over the composed stack,
 * isolating the adapter+rail+supply path from the Hermes runtime.
 * Development-time tooling only.
 */
import { readFileSync } from "node:fs";
import { composeProofStack } from "../harness/compose";
import { createAdapterServer } from "../adapter/server";
import { createEgressProxy } from "../harness/egress-proxy";
import { KNOWN_PHRASE_WAV_PATH } from "../corpus/tasks";
import { createZeckClient } from "../../../sdk";

async function main(): Promise<void> {
  const stack = await composeProofStack({ minDispatchIntervalMs: 600, retryCooldownMs: 3000 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const proxy = await createEgressProxy();
  console.log(`adapter=${adapter.url}`);

  // 1. speech
  {
    const response = await fetch(`${adapter.url}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer probe" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: "Adapter surface probe.",
        voice: "alloy",
        response_format: "wav",
      }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    console.log(
      `[speech] status=${response.status} type=${response.headers.get("content-type")} bytes=${bytes.length} head=${bytes.subarray(0, 4).toString("hex")}`,
    );
    if (response.status !== 200) {
      console.log(`[speech] body=${bytes.toString("utf8").slice(0, 300)}`);
    }
  }

  // 2. transcriptions (multipart, like the openai SDK)
  {
    const audio = readFileSync(KNOWN_PHRASE_WAV_PATH);
    const boundary = `----probe${Date.now()}`;
    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="memo.wav"\r\ncontent-type: audio/wav\r\n\r\n`));
    parts.push(audio);
    parts.push(Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`));
    const response = await fetch(`${adapter.url}/audio/transcriptions`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: "Bearer probe" },
      body: Buffer.concat(parts),
    });
    const text = await response.text();
    console.log(`[stt] status=${response.status} body=${text.slice(0, 200)}`);
  }

  // 3. images
  {
    const response = await fetch(`${adapter.url}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer probe" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a teal circle icon", size: "1024x1024", n: 1 }),
    });
    const text = await response.text();
    let summary = text.slice(0, 160);
    try {
      const parsed = JSON.parse(text) as { data?: { b64_json?: string }[] };
      if (parsed.data?.[0]?.b64_json) {
        summary = `b64 length ${parsed.data[0].b64_json.length}`;
      }
    } catch {
      // keep raw
    }
    console.log(`[image] status=${response.status} body=${summary}`);
  }

  console.log("=== adapter logs ===");
  for (const log of adapter.requests()) {
    console.log(`${log.surface} ${log.edgeId} -> ${log.executionId} terminal=${log.terminal}`);
  }

  // Failure readback: the failed executions' model-failure events.
  for (const log of adapter.requests()) {
    if (log.terminal === "FAILED") {
      const client = createZeckClient({
        baseUrl: stack.apiBaseUrl,
        token: stack.apiToken,
        applicationId: stack.applicationId,
      });
      const events = await client.listEvents(log.executionId);
      for (const event of events) {
        if (event.type === "execution.tool-result" || event.type === "execution.tool-denied") {
          console.log(`[fail ${log.executionId}] ${event.type}:`, JSON.stringify(event.payload).slice(0, 400));
        }
      }
    }
  }

  adapter.close();
  proxy.close();
  await stack.close();
}

main().catch((error) => {
  console.error("PROBE FAILED:", error);
  process.exit(1);
});
