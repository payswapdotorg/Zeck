/**
 * Dependency-rule engine for the architecture tests (WORK-001).
 *
 * Encodes the dependency direction of `IMPLEMENTATION.md` §3 and the frozen
 * architecture v1.0 as an executable, source-only rule set:
 *
 * ```text
 * api -> module public contract -> module application/domain
 *      -> module ports -> adapters/platform
 * ```
 *
 * The scanner is pure: it takes an in-memory set of source files and returns
 * violations. `tests/architecture/*.test.ts` runs it over the real `src/`
 * tree; `tests/discrimination/*.test.ts` proves with synthetic violations
 * that every protection actually discriminates (a weakened protection is
 * rejected).
 *
 * Rules:
 * - `cross-module-public-only`     modules/integrations import other modules
 *                                  only through their `public.ts` barrel.
 * - `internal-never-cross-module`  another module's `internal/` is never
 *                                  importable from outside.
 * - `api-boundary`                 transport imports only public barrels and
 *                                  shared primitives.
 * - `public-contract-purity`       public barrels never expose platform types.
 * - `domain-coupled-to-platform`   domain/application/ports never import the
 *                                  platform (no infrastructure coupling).
 * - `module-layer-direction`       layers point inwards only (domain never
 *                                  imports application/adapters, etc.).
 * - `platform-isolation`           platform never imports modules or api.
 * - `shared-isolation`             shared stays dependency-light.
 * - `module-imports-api`           modules/integrations never import the api.
 * - `provider-sdk-outside-adapter` provider/infrastructure SDKs are only
 *                                  importable inside their owning adapter
 *                                  area (see `PROVIDER_SDK_BOUNDARIES`).
 * - `domain-runtime-import`        domain layers never import HTTP/process
 *                                  runtime modules.
 * - `undeclared-package-import`    default-deny: `src/` may only import
 *                                  declared runtime dependencies.
 * - `import-resolution`            relative imports must resolve inside the
 *                                  scanned set.
 */
import { posix } from "node:path";

export interface SourceFile {
  /** POSIX path relative to the repository root, e.g. `src/modules/auth/public.ts`. */
  readonly path: string;
  readonly content: string;
}

export type RuleId =
  | "cross-module-public-only"
  | "internal-never-cross-module"
  | "api-boundary"
  | "public-contract-purity"
  | "domain-coupled-to-platform"
  | "module-layer-direction"
  | "platform-isolation"
  | "shared-isolation"
  | "module-imports-api"
  | "provider-sdk-outside-adapter"
  | "domain-runtime-import"
  | "undeclared-package-import"
  | "import-resolution";

export interface RuleViolation {
  readonly rule: RuleId;
  readonly path: string;
  readonly importSpecifier: string;
  readonly resolvedTo: string | null;
  readonly detail: string;
}

export interface ScanOptions {
  /**
   * Bare package specifiers legal inside `src/` (the runtime dependencies of
   * package.json). Anything else fails closed as undeclared.
   */
  readonly allowedPackages?: readonly string[];
}

type ZoneKind = "api" | "shared" | "platform" | "module" | "integration" | "outside-src";

interface Zone {
  readonly kind: ZoneKind;
  readonly id?: string;
  readonly layer?: string;
}

/** Module layers that must stay free of infrastructure concerns. */
const INNER_LAYERS = ["domain", "application", "ports"] as const;

/** Runtime modules domain code must never touch (HTTP libraries, process control). */
const DOMAIN_RUNTIME_DENYLIST = [
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "node:tls",
  "node:child_process",
  "node:worker_threads",
] as const;

export interface SdkBoundary {
  /** Package name or `@scope/prefix*` pattern. */
  readonly packagePattern: string;
  /** Only file paths with this prefix may import the package. */
  readonly allowedPathPrefix: string;
  readonly owner: string;
}

/**
 * Provider SDK / infrastructure client boundaries
 * (`IMPLEMENTATION.md` §1: "No provider SDK may be imported outside its
 * owning adapter package/module"). Extending the table is a reviewed
 * architecture-test change, not a silent one.
 */
export const PROVIDER_SDK_BOUNDARIES: readonly SdkBoundary[] = [
  { packagePattern: "fastify", allowedPathPrefix: "src/api/", owner: "API transport" },
  { packagePattern: "@fastify/*", allowedPathPrefix: "src/api/", owner: "API transport" },
  {
    packagePattern: "pg",
    allowedPathPrefix: "src/platform/db/",
    owner: "platform database adapter",
  },
  {
    packagePattern: "postgres",
    allowedPathPrefix: "src/platform/db/",
    owner: "platform database adapter",
  },
  {
    packagePattern: "@neondatabase/*",
    allowedPathPrefix: "src/platform/db/",
    owner: "platform database adapter",
  },
  {
    packagePattern: "redis",
    allowedPathPrefix: "src/platform/redis/",
    owner: "platform coordination adapter",
  },
  {
    packagePattern: "ioredis",
    allowedPathPrefix: "src/platform/redis/",
    owner: "platform coordination adapter",
  },
  {
    packagePattern: "@aws-sdk/*",
    allowedPathPrefix: "src/platform/object-store/",
    owner: "platform object-store adapter",
  },
  {
    packagePattern: "@smithy/*",
    allowedPathPrefix: "src/platform/object-store/",
    owner: "platform object-store adapter",
  },
  {
    packagePattern: "minio",
    allowedPathPrefix: "src/platform/object-store/",
    owner: "platform object-store adapter",
  },
  {
    packagePattern: "openai",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@anthropic-ai/*",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@google/generative-ai",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@google/genai",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@mistralai/*",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "cohere-ai",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "groq-sdk",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@azure/openai",
    allowedPathPrefix: "src/modules/models/adapters/",
    owner: "models module provider adapters",
  },
  {
    packagePattern: "@workflowos/*",
    allowedPathPrefix: "src/integrations/workflowos/adapters/",
    owner: "workflowos integration adapters",
  },
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*import\s+[^;'"]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s+[^;'"]*?from\s*["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
];

export function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(content);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
      match = regex.exec(content);
    }
  }
  return [...specifiers];
}

export function classifyZone(path: string): Zone {
  const segments = path.split("/");
  if (segments[0] !== "src" || segments.length < 2) {
    return { kind: "outside-src" };
  }
  switch (segments[1]) {
    case "api":
      return { kind: "api" };
    case "shared":
      return { kind: "shared" };
    case "platform":
      return { kind: "platform" };
    case "modules":
    case "integrations": {
      const id = segments[2];
      if (id === undefined) {
        return { kind: "outside-src" };
      }
      // A file directly in the module root (e.g. `public.ts`) is layer "root";
      // the first path segment below the module id is the layer directory.
      const rawLayer = segments[3];
      const layer = rawLayer === undefined || rawLayer.endsWith(".ts") ? "root" : rawLayer;
      return {
        kind: segments[1] === "modules" ? "module" : "integration",
        id,
        layer,
      };
    }
    default:
      return { kind: "outside-src" };
  }
}

export function isPublicBarrel(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length === 4 &&
    segments[0] === "src" &&
    (segments[1] === "modules" || segments[1] === "integrations") &&
    segments[3] === "public.ts"
  );
}

export function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (name === undefined) {
      return scope ?? specifier;
    }
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0] ?? specifier;
}

function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return name === pattern;
  }
  const parts = pattern.split("*");
  const prefix = parts[0] ?? "";
  const suffix = parts[1] ?? "";
  return (
    name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
  );
}

export function sdkBoundaryFor(packageName: string): SdkBoundary | undefined {
  return PROVIDER_SDK_BOUNDARIES.find((boundary) =>
    matchesPattern(packageName, boundary.packagePattern),
  );
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  paths: Set<string>,
): string | null {
  const directory = posix.dirname(fromPath);
  const target = posix.normalize(posix.join(directory, specifier));
  const candidates = [
    target,
    `${target}.ts`,
    target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : `${posix.join(target, "index")}.ts`,
  ];
  for (const candidate of candidates) {
    if (paths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function scanDependencyRules(
  files: readonly SourceFile[],
  options: ScanOptions = {},
): RuleViolation[] {
  const allowedPackages = new Set(options.allowedPackages ?? []);
  const knownPaths = new Set(files.map((file) => file.path));
  const violations: RuleViolation[] = [];

  const report = (
    rule: RuleId,
    path: string,
    importSpecifier: string,
    resolvedTo: string | null,
    detail: string,
  ): void => {
    violations.push({ rule, path, importSpecifier, resolvedTo, detail });
  };

  for (const file of files) {
    const zone = classifyZone(file.path);
    if (zone.kind === "outside-src") {
      continue;
    }

    for (const specifier of extractImportSpecifiers(file.content)) {
      const isRelative = specifier.startsWith(".") || specifier.startsWith("/");

      if (!isRelative) {
        if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
          if (
            (zone.kind === "module" || zone.kind === "integration") &&
            zone.layer !== undefined &&
            INNER_LAYERS.includes(zone.layer as (typeof INNER_LAYERS)[number]) &&
            (DOMAIN_RUNTIME_DENYLIST as readonly string[]).includes(specifier)
          ) {
            report(
              "domain-runtime-import",
              file.path,
              specifier,
              null,
              `${zone.layer} layers must not import runtime modules (${specifier})`,
            );
          }
          continue;
        }

        const packageName = packageNameOf(specifier);
        const boundary = sdkBoundaryFor(packageName);
        if (boundary !== undefined && !file.path.startsWith(boundary.allowedPathPrefix)) {
          report(
            "provider-sdk-outside-adapter",
            file.path,
            specifier,
            null,
            `${packageName} is only importable inside ${boundary.allowedPathPrefix} (${boundary.owner})`,
          );
        }
        if (!allowedPackages.has(packageName)) {
          report(
            "undeclared-package-import",
            file.path,
            specifier,
            null,
            `${packageName} is not a declared runtime dependency; src/ imports fail closed`,
          );
        }
        continue;
      }

      const resolved = resolveRelativeImport(file.path, specifier, knownPaths);
      if (resolved === null) {
        report(
          "import-resolution",
          file.path,
          specifier,
          null,
          "relative import does not resolve in the scanned set",
        );
        continue;
      }
      const target = classifyZone(resolved);

      // internal/ directories are never importable from outside their owning
      // module/integration — regardless of which zone the importer lives in
      // (api, shared, platform, another module or integration).
      if (
        (target.kind === "module" || target.kind === "integration") &&
        resolved.includes("/internal/")
      ) {
        const sameOwner =
          (zone.kind === "module" || zone.kind === "integration") && zone.id === target.id;
        if (!sameOwner) {
          report(
            "internal-never-cross-module",
            file.path,
            specifier,
            resolved,
            `${resolved} is internal to ${target.id} and must never be imported from outside that module`,
          );
        }
      }

      // Transport boundary: api composes public contracts and shared primitives only.
      if (zone.kind === "api") {
        const permitted =
          target.kind === "api" ||
          target.kind === "shared" ||
          ((target.kind === "module" || target.kind === "integration") && isPublicBarrel(resolved));
        if (!permitted) {
          report(
            "api-boundary",
            file.path,
            specifier,
            resolved,
            "api (transport only) may import module public barrels and src/shared, nothing else",
          );
        }
      }

      // Shared stays dependency-light: no modules/platform/api imports.
      if (
        zone.kind === "shared" &&
        ["module", "integration", "platform", "api"].includes(target.kind)
      ) {
        report(
          "shared-isolation",
          file.path,
          specifier,
          resolved,
          `src/shared must not import ${target.kind} code`,
        );
      }

      // Platform never depends on domain modules or transport.
      if (zone.kind === "platform" && ["module", "integration", "api"].includes(target.kind)) {
        report(
          "platform-isolation",
          file.path,
          specifier,
          resolved,
          "src/platform must never import modules, integrations or api",
        );
      }

      if (zone.kind === "module" || zone.kind === "integration") {
        if (target.kind === "api") {
          report(
            "module-imports-api",
            file.path,
            specifier,
            resolved,
            "modules and integrations never import the api layer",
          );
        }

        if (target.kind === "platform") {
          if (
            zone.layer !== undefined &&
            INNER_LAYERS.includes(zone.layer as (typeof INNER_LAYERS)[number])
          ) {
            report(
              "domain-coupled-to-platform",
              file.path,
              specifier,
              resolved,
              `${zone.layer} layers must depend on module ports, never on src/platform`,
            );
          }
          if (zone.layer === "root") {
            report(
              "public-contract-purity",
              file.path,
              specifier,
              resolved,
              "public barrels must stay provider-neutral (no platform types)",
            );
          }
        }

        if (target.kind === "module" || target.kind === "integration") {
          const crossesOwner = target.id !== zone.id;
          if (crossesOwner) {
            if (!isPublicBarrel(resolved)) {
              report(
                "cross-module-public-only",
                file.path,
                specifier,
                resolved,
                `cross-module imports must target the ${target.id}/public.ts barrel`,
              );
            }
          } else if (zone.layer !== undefined && target.layer !== undefined) {
            const inversion =
              (zone.layer === "domain" &&
                (target.layer === "application" || target.layer === "adapters")) ||
              ((zone.layer === "application" || zone.layer === "ports") &&
                target.layer === "adapters");
            if (inversion) {
              report(
                "module-layer-direction",
                file.path,
                specifier,
                resolved,
                `${zone.layer} must not import ${target.layer}; direction is domain -> application -> ports -> adapters`,
              );
            }
          }
        }
      }
    }
  }

  return violations;
}
