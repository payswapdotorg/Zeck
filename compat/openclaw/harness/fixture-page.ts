/**
 * The browser corpus task's loopback fixture page (PPR-023): a tiny
 * loopback HTTP server serving the task's token page, so the
 * browser-backed corpus task (browser-answer) has a REAL page to open,
 * read and act on — browser ACTUATION is app-owned (the pinned runtime's
 * own CDP/Chromium tooling); the page is proof-side fixture data.
 *
 * Serves exactly one route: GET /token.html — the token in large plain
 * text (plus the minimal HTML shell a headless browser renders). Every
 * other path 404s. No AI, no egress, no state.
 */

import { createServer, type Server } from "node:http";

export interface LoopbackTokenPage {
  readonly port: number;
  readonly url: string;
  close(): void;
}

/** Start the token page on the given loopback port. */
export function createLoopbackTokenPage(
  port: number,
  token: string,
): Promise<LoopbackTokenPage> {
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Access Token</title></head>
<body>
  <main>
    <h1>Access Token</h1>
    <p>The access token displayed on this page is:</p>
    <p id="token" style="font-size:2rem;font-family:monospace">${token}</p>
  </main>
</body>
</html>
`;
  const server = createServer((request, response) => {
    if (request.url === "/token.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        url: `http://127.0.0.1:${port}/token.html`,
        close() {
          server.close();
        },
      });
    });
  });
}

/** Await a server's full shutdown (test teardown helper). */
export function closed(page: LoopbackTokenPage): Promise<void> {
  return new Promise((resolve) => {
    const server: Server | undefined = (page as unknown as { server?: Server }).server;
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
