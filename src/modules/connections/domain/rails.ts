/**
 * Provider rail vocabulary (connections module domain).
 *
 * A "rail" is a provider-neutral slug naming a supply path for model
 * capability: an aggregation rail (`openrouter`) or a direct provider
 * (`anthropic`). This file is the ONE sanctioned home for provider names in
 * this module — the slugs are configuration data (strings), not provider SDK
 * types, and no rail-specific behavior may live outside the owning adapter in
 * `/models` (`spec/architecture.md` §2.3, `IMPLEMENTATION.md` §10).
 *
 * `custom` covers customer OpenAI-compatible endpoints (`endpoint_url`
 * required) — "customer endpoints" are part of this module's responsibility
 * (`spec/architecture.md` §6).
 */

export const PROVIDER_RAILS = ["openrouter", "anthropic", "custom"] as const;

export type RailSlug = (typeof PROVIDER_RAILS)[number];

export function isProviderRail(value: string): value is RailSlug {
  return (PROVIDER_RAILS as readonly string[]).includes(value);
}

/** Connection labels are human-managed slugs, unique per application. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export function isValidConnectionLabel(label: string): boolean {
  return LABEL_PATTERN.test(label);
}

/** https/http endpoint override for customer or gateway fronts. */
export function isValidEndpointUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
