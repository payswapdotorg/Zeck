/**
 * The PPR-019 Cline runtime configuration — the proof-environment
 * configuration seeding for the pinned Cline CLI (the unmodified
 * application's OWN configuration surface: the CLI's `--config`/
 * `--data-dir` isolation plus its native provider-settings and
 * global-settings files — the same integration seam a real user would
 * configure, never a code fork).
 *
 * The seeded provider is the CLI's own built-in `openai-compatible`
 * provider pointed at the local Zeck adapter:
 *
 *   provider:      "openai-compatible" (Cline's own built-in id)
 *   baseUrl:       http://127.0.0.1:<adapter-port>/v1
 *   apiKey:        "zeck-local-adapter" — the LITERAL PLACEHOLDER the
 *                  client-side shape check requires; it is NOT a
 *                  credential of any provider (the adapter ignores the
 *                  Authorization header entirely; no provider endpoint
 *                  is reachable from the Cline runtime — the egress
 *                  control denies every non-loopback host)
 *   model:         the rail's model identity (an opaque neutral string
 *                  to Cline; the rail owns the actual supply model)
 *
 * Credentials are additionally scrubbed at the environment level (see
 * runtime-spawn.ts) and recorded as presence/absence facts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The placeholder the openai-compatible client's shape check requires. */
export const ZECK_ADAPTER_API_KEY_PLACEHOLDER = "zeck-local-adapter";

/** The provider id of Cline's built-in OpenAI-compatible seam. */
export const CLINE_PROVIDER_ID = "openai-compatible";

export interface ClineRuntimeConfig {
  /** The isolated config directory (--config; CLINE_DIR). */
  readonly configDir: string;
  /** The isolated data directory (--data-dir). */
  readonly dataDir: string;
  /** The Zeck adapter base URL (http://127.0.0.1:<port>/v1). */
  readonly adapterBaseUrl: string;
  /** The model id the provider settings carry (opaque neutral string). */
  readonly modelId: string;
  /**
   * The context window the provider settings declare. A small value on
   * the compaction task forces the CLI's own agentic compaction to fire
   * mid-task (the auxiliary edge).
   */
  readonly contextWindow?: number;
  /** Compaction mode override (CLI --compaction is per-run; this is the settings-level default). */
  readonly compactionEnabled?: boolean;
}

/** The stored provider-settings shape (ProviderSettingsManager's file). */
export interface StoredProviderSettingsFile {
  version: 1;
  lastUsedProvider?: string;
  modes: Record<string, unknown>;
  providers: Record<
    string,
    {
      settings: Record<string, unknown>;
      updatedAt: string;
      tokenSource: "manual" | "oauth" | "migration";
    }
  >;
}

/** The global-settings shape (GlobalSettingsSchema). */
export interface GlobalSettingsFile {
  telemetryOptOut?: boolean;
  autoUpdateEnabled?: boolean;
  compactionStrategy?: "basic" | "agentic";
  compactionEnabled?: boolean;
}

/** Seed the isolated config/data directories for one Cline run. */
export function seedClineRuntimeConfig(config: ClineRuntimeConfig): void {
  mkdirSync(join(config.dataDir, "settings"), { recursive: true });
  mkdirSync(config.configDir, { recursive: true });

  const providers: StoredProviderSettingsFile = {
    version: 1,
    lastUsedProvider: CLINE_PROVIDER_ID,
    modes: {},
    providers: {
      [CLINE_PROVIDER_ID]: {
        settings: {
          provider: CLINE_PROVIDER_ID,
          apiKey: ZECK_ADAPTER_API_KEY_PLACEHOLDER,
          model: config.modelId,
          baseUrl: config.adapterBaseUrl,
          ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  };
  writeFileSync(
    join(config.dataDir, "settings", "providers.json"),
    JSON.stringify(providers, null, 2),
  );

  const globalSettings: GlobalSettingsFile = {
    telemetryOptOut: true,
    autoUpdateEnabled: false,
    ...(config.compactionEnabled === undefined ? {} : { compactionEnabled: config.compactionEnabled }),
  };
  writeFileSync(
    join(config.dataDir, "settings", "global-settings.json"),
    JSON.stringify(globalSettings, null, 2),
  );
}

/** Read back the seeded provider entry (the corpus runner's verification). */
export function readSeededProviderSettings(
  config: ClineRuntimeConfig,
): StoredProviderSettingsFile | null {
  try {
    return JSON.parse(
      readFileSync(join(config.dataDir, "settings", "providers.json"), "utf8"),
    ) as StoredProviderSettingsFile;
  } catch {
    return null;
  }
}
