/**
 * The PPR-023 runtime preload — registered into every pinned-OpenClaw
 * runtime process through the scrubbed environment's NODE_OPTIONS axis
 * (it loads BEFORE the app's own tsx loader on the command line, so the
 * hook chain runs tsx's resolution first and this hook's redirect
 * second — the redirect sees the `.ts` URL the loader mapped and swaps
 * it for the compiled sibling; see runtime-loader-hook.mjs for the full
 * provenance disclosure).
 */
import { register } from "node:module";

const REGISTERED = Symbol.for("ppr-023.runtime-loader-hook");

if (globalThis[REGISTERED] !== true) {
  globalThis[REGISTERED] = true;
  register(new URL("./runtime-loader-hook.mjs", import.meta.url));
}
