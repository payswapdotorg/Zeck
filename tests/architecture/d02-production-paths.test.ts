/**
 * Architecture: the D-02 production-path boundaries (WORK-043 /
 * Deployment Roadmap D-02; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 BYTES NEVER CROSS THE AUTHORITY PATH: `src/platform/object-store/**`
 *    imports nothing from `src/platform/db/**` and vice versa — artifact
 *    bytes and authoritative relational state are separate planes
 *    (D1.0 §8: "Large request/response bodies must not be copied
 *    unnecessarily through PostgreSQL"; R2 stores bytes only).
 *  - B2 THE PORTS ARE UNCHANGED CONTRACTS: the `ObjectStorePort` is
 *    exactly put/get/delete (delegated/presign capabilities live in
 *    the ADAPTER module, never on the port — no R2/S3 concept leaks
 *    into the port contract); the `DatabasePort` is exactly
 *    transaction/execute.
 *  - B3 PLATFORM ISOLATION: the new platform adapters import no
 *    module/integration/api surface (the shared rule engine pins the
 *    tree; here the D-02 files are pinned explicitly).
 *  - B4 NO NEW MIGRATION / NO SCHEMA MUTATION: D-02 is a COMPATIBILITY
 *    consumer of the existing schema — the migrations directory still
 *    carries exactly the 24 shipped files (0015 burned, none added by
 *    this Work Order; artifact lifecycle/retention schema is future
 *    owned Work Order surface).
 *  - B5 SECRET-FREE SOURCES: the new platform/deploy sources contain
 *    no credential-shaped literals (keys, tokens, URL-embedded
 *    credentials) — secret values are environment-only.
 *  - B6 PROVIDER TERMS CONFINED: R2/S3/Neon/Cloudflare vocabulary
 *    appears only in the owning adapters/deploy tooling — never in
 *    domain modules, never on ports.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function listFiles(dir: string, suffix = ".ts"): string[] {
  const base = join(REPO_ROOT, dir);
  const walk = (current: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel, out);
      } else if (entry.name.endsWith(suffix)) {
        out.push(rel);
      }
    }
  };
  const out: string[] = [];
  walk(base, dir, out);
  return out.sort();
}

function importSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:^|\n)\s*import\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(content);
    while (match !== null) {
      if (match[1] !== undefined) {
        specifiers.add(match[1]);
      }
      match = regex.exec(content);
    }
  }
  return [...specifiers];
}

const DB_SOURCES = listFiles("src/platform/db").filter((f) => f.endsWith(".ts"));
const OBJECT_STORE_SOURCES = listFiles("src/platform/object-store");

describe("the D-02 production-path boundaries (WORK-043)", () => {
  test("B1: the object-store plane never imports the db plane (and vice versa)", () => {
    for (const file of OBJECT_STORE_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      const dbImports = specifiers.filter((s) => s.includes("platform/db"));
      expect(dbImports, `${file} must not import the database plane`).toEqual([]);
    }
    for (const file of DB_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      const storeImports = specifiers.filter((s) => s.includes("object-store"));
      expect(storeImports, `${file} must not import the object-store plane`).toEqual([]);
    }
  });

  test("B2: the ports remain the frozen minimal contracts", () => {
    const objectStorePort = read("src/platform/object-store/port.ts");
    expect(objectStorePort).toContain("export interface ObjectStorePort");
    for (const method of ["put(", "get(", "delete("]) {
      expect(objectStorePort).toContain(method);
    }
    // No provider capability leaked onto the port.
    for (const forbidden of ["presign", "headBucket", "SigV4", "aws", "r2", "bucket"]) {
      expect(objectStorePort.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    const dbPort = read("src/platform/db/port.ts");
    expect(dbPort).toContain("export interface DatabasePort");
    expect(dbPort).toContain("transaction<T>");
    expect(dbPort).toContain("execute<T");
    for (const forbidden of ["neon", "pool", "pg", "sslmode"]) {
      expect(dbPort.toLowerCase()).not.toContain(` ${forbidden}`);
    }
  });

  test("B3: the new platform adapters import no module/integration/api surface", () => {
    const platformFiles = [
      ...DB_SOURCES,
      ...OBJECT_STORE_SOURCES,
      ...listFiles("src/platform/secret-store"),
    ];
    for (const file of platformFiles) {
      const specifiers = importSpecifiers(read(file));
      const violations = specifiers.filter(
        (s) => s.includes("modules/") || s.includes("integrations/") || s.includes("api/"),
      );
      expect(violations, `${file} violates platform isolation`).toEqual([]);
    }
  });

  test("B4: D-02 added no migration (the existing schema is the compatibility target)", () => {
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort();
    expect(migrations).toHaveLength(24);
    expect(migrations[0]).toMatch(/^0001_/);
    expect(migrations[migrations.length - 1]).toMatch(/^0025_/);
    expect(migrations.map((name) => name.slice(0, 4))).not.toContain("0015");
    expect(migrations.map((name) => name.slice(0, 4))).not.toContain("0026");
  });

  test("B5: the new platform/deploy sources carry no credential-shaped literals", () => {
    const scanned = [
      ...DB_SOURCES,
      ...OBJECT_STORE_SOURCES,
      ...listFiles("src/platform/secret-store"),
      ...listFiles("deploy").filter((f) => !f.endsWith("manifests/")),
    ];
    const patterns: readonly { name: string; pattern: RegExp }[] = [
      { name: "AWS access key literal", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
      { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
      { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
      {
        name: "URL-embedded credentials",
        pattern: /postgres(ql)?:\/\/[^\s"'@/:]+:[^\s"'@]+@/,
      },
    ];
    for (const file of scanned) {
      const content = read(file);
      for (const { name, pattern } of patterns) {
        expect(pattern.test(content), `${file} contains ${name}`).toBe(false);
      }
    }
  });

  test("B6: provider vocabulary never appears in domain modules (it lives in adapters/deploy tooling)", () => {
    // The neutrality boundary that matters: DOMAIN modules (and the
    // ports themselves — B2 pins those) never carry provider
    // vocabulary. Platform adapter files may document their provider
    // context in comments (that is where the vocabulary BELONGS).
    const domainFiles = [
      ...listFiles("src/modules"),
      ...listFiles("src/integrations"),
      ...listFiles("src/api"),
    ];
    const violations: string[] = [];
    for (const file of domainFiles) {
      const content = read(file);
      if (/\b(cloudflare|r2|neon|sigv4|aws4)\b/i.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
