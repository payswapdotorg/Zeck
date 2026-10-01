/**
 * The PPR-021 Continue runtime configuration — the proof-environment
 * configuration seeding for the pinned Continue runtime (the unmodified
 * application's OWN configuration surface: an isolated
 * CONTINUE_GLOBAL_DIR with a fully-local config.yaml — exactly the seam
 * a real Continue user configures, never a code fork).
 *
 * The seeded models use Continue's own OpenAI-compatible seam (the
 * `openai` provider with a custom apiBase) — ONE MODEL ENTRY PER ROLE,
 * each with a role-identifying model id:
 *
 *   provider:      "openai" (Continue's built-in OpenAI-compatible class)
 *   apiBase:       http://127.0.0.1:<adapter-port>/v1 (the Zeck adapter)
 *   apiKey:        "zeck-local-adapter" — the LITERAL PLACEHOLDER the
 *                  client-side shape check requires; it is NOT a
 *                  credential of any provider (the adapter ignores the
 *                  Authorization header entirely; no provider endpoint
 *                  is reachable from the Continue runtime — the egress
 *                  controls deny every non-loopback host)
 *   model:         the role-identifying id (zeck-chat / zeck-subagent /
 *                  zeck-edit / zeck-apply / zeck-autocomplete /
 *                  zeck-embed / zeck-rerank) — the adapter's
 *                  deterministic role selector
 *
 * The subagent model additionally carries chatOptions.baseSystemMessage
 * (the CLI's own subagent-availability rule: models with role subagent
 * AND a base system message become spawnable subagents).
 *
 * Credentials are additionally scrubbed at the environment level (see
 * runtime-spawn.ts) and recorded as presence/absence facts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUE_ROLE_MODELS } from "../adapter/edges";

/** The placeholder the openai client's shape check requires (never a credential). */
export const ZECK_ADAPTER_API_KEY_PLACEHOLDER = "zeck-local-adapter";

/** The provider id of Continue's built-in OpenAI-compatible seam. */
export const CONTINUE_PROVIDER_ID = "openai";

export interface ContinueRuntimeConfig {
  /** The isolated CONTINUE_GLOBAL_DIR (the app's own home isolation). */
  readonly homeDir: string;
  /** The Zeck adapter base URL (http://127.0.0.1:<port>/v1). */
  readonly adapterBaseUrl: string;
  /**
   * The DIRECT-BASELINE arm's credential materialization: the real
   * supply api key + session headers ride the app's OWN configuration
   * axes (apiKey + requestOptions.headers) — the credential lives in
   * the APPLICATION runtime for this arm, by definition of a direct
   * baseline (the Zeck arm never sets this).
   */
  readonly directArm?: {
    readonly apiKey: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/** The seeded subagent definition (the app's own model-level agent surface). */
export const SUBAGENT_MODEL_NAME = "Explorer";
const SUBAGENT_SYSTEM_MESSAGE = [
  "You are a workspace exploration specialist.",
  "Use the tools you have to inspect the workspace and report the exact",
  "facts the caller asked for. Be terse and precise.",
].join(" ");

interface ModelEntry {
  readonly name: string;
  readonly model: string;
  readonly roles: readonly string[];
  readonly extra?: string;
}

const MODEL_ENTRIES: readonly ModelEntry[] = [
  { name: "Zeck Chat", model: CONTINUE_ROLE_MODELS.chat, roles: ["chat"] },
  {
    name: SUBAGENT_MODEL_NAME,
    model: CONTINUE_ROLE_MODELS.subagent,
    roles: ["subagent"],
    extra: [
      "    chatOptions:",
      `      baseSystemMessage: ${JSON.stringify(SUBAGENT_SYSTEM_MESSAGE)}`,
    ].join("\n"),
  },
  { name: "Zeck Edit", model: CONTINUE_ROLE_MODELS.edit, roles: ["edit"] },
  { name: "Zeck Apply", model: CONTINUE_ROLE_MODELS.apply, roles: ["apply"] },
  {
    name: "Zeck Autocomplete",
    model: CONTINUE_ROLE_MODELS.autocomplete,
    roles: ["autocomplete"],
  },
  { name: "Zeck Embed", model: CONTINUE_ROLE_MODELS.embed, roles: ["embed"] },
  { name: "Zeck Rerank", model: CONTINUE_ROLE_MODELS.rerank, roles: ["rerank"] },
];

/** Render the fully-local config.yaml (Continue's own configuration surface). */
export function renderContinueConfigYaml(
  adapterBaseUrl: string,
  directArm?: ContinueRuntimeConfig["directArm"],
): string {
  const base = adapterBaseUrl.replace(/\/+$/, "");
  const apiKey = directArm?.apiKey ?? ZECK_ADAPTER_API_KEY_PLACEHOLDER;
  const requestOptions =
    directArm === undefined
      ? []
      : [
          "    requestOptions:",
          `      headers:`,
          ...Object.entries(directArm.headers).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`),
        ];
  const models = MODEL_ENTRIES.map(
    (entry) =>
      [
        `  - name: ${JSON.stringify(entry.name)}`,
        `    provider: ${CONTINUE_PROVIDER_ID}`,
        `    model: ${entry.model}`,
        `    apiBase: ${base}/`,
        `    apiKey: ${JSON.stringify(apiKey)}`,
        ...requestOptions,
        `    roles: [${entry.roles.join(", ")}]`,
        `    defaultCompletionOptions:`,
        `      contextLength: 8192`,
        ...(entry.extra === undefined ? [] : [entry.extra]),
      ].join("\n"),
  ).join("\n");
  return [
    "name: zeck-proof",
    "version: 0.0.1",
    "schemas:",
    "  - name: base",
    "    version: 0.0.1",
    "models:",
    models,
    "",
  ].join("\n");
}

/** Seed the isolated CONTINUE_GLOBAL_DIR with the config.yaml. */
export function seedContinueRuntimeConfig(config: ContinueRuntimeConfig): string {
  mkdirSync(config.homeDir, { recursive: true });
  const configPath = join(config.homeDir, "config.yaml");
  writeFileSync(configPath, renderContinueConfigYaml(config.adapterBaseUrl, config.directArm));
  return configPath;
}
