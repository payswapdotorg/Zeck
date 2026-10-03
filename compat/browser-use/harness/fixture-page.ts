/**
 * The PPR-024 loopback fixture pages — the corpus's mechanical
 * verification targets (the identical discipline PPR-023 established:
 * self-contained loopback HTML, no external references, a token the
 * task must extract through the DELEGATED substrate).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The fixture page's loopback port (stable so the task spec can pin it). */
export const FIXTURE_PAGE_PORT = 24601 as const;

export interface FixturePage {
  readonly port: number;
  readonly url: string;
  /** Whether the page has been served at least once (introspection). */
  readonly served: boolean;
  /** Resolves when the listener is bound (the fallback port path binds asynchronously). */
  ready(): Promise<void>;
  close(): void;
}

export interface FixturePageOptions {
  readonly port: number;
  /** The hidden token the page reveals when the target button is clicked. */
  readonly token: string;
  /** The clickable element's visible text. */
  readonly buttonText: string;
  /** The token marker in the DOM text. */
  readonly tokenMarker: string;
}

/** Serve the self-contained reveal-token fixture page on a loopback port. */
export function createRevealTokenPage(options: FixturePageOptions): FixturePage {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Zeck PPR-024 Fixture</title>
<style>
body { font-family: sans-serif; margin: 3rem; }
button { font-size: 1.2rem; padding: 0.6rem 1.4rem; margin: 1rem 0; }
#token { display: none; font-weight: bold; }
</style>
<script>
function reveal() {
  document.getElementById('token').style.display = 'block';
  document.getElementById('status').textContent = 'Token revealed';
}
</script>
</head>
<body>
<h1>Delegate Proof Page</h1>
<p>This page is served on loopback for the certified corpus.</p>
<button id="reveal-btn" type="button" onclick="reveal()">${options.buttonText}</button>
<p id="status">Nothing revealed yet</p>
<p id="token">${options.tokenMarker} ${options.token}</p>
</body>
</html>`;
  const server: Server = createServer((request, response) => {
    if ((request.url ?? "") === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  // The page is served at construction (the preferred port, falling back to
  // an ephemeral port when a stale process still holds it); the caller
  // closes it.
  const listen = async (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  let served = false;
  const tryListen = async (): Promise<void> => {
    try {
      await listen(options.port);
      served = true;
    } catch {
      await listen(0);
      served = true;
    }
  };
  void tryListen();
  return {
    get port() {
      return (server.address() as AddressInfo).port;
    },
    get url() {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    },
    get served() {
      return served;
    },
    async ready(): Promise<void> {
      const startedAt = Date.now();
      while (!served && Date.now() - startedAt < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close() {
      server.close();
    },
  };
}
