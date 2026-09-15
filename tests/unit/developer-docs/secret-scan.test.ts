/**
 * The kit's secret scan (DEP-020 acceptance criterion 6: no secret
 * value is embedded in examples or generated artifacts).
 *
 * Scans EVERY file the integration kit owns — docs/developer/**,
 * examples/** and the kit's own tests — with the same
 * credential-shaped literal patterns the deployment tooling uses
 * (`deploy/lib.ts`, scanManifestsForSecretPlaintext), plus the
 * repo-specific probe-record pattern from the validation program.
 * Credential NAMES are allowed; credential VALUES are not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
      } else {
        found.push(full);
      }
    }
  };
  visit(root);
  return found;
}

const KIT_FILES = [
  ...walkFiles(join(REPOSITORY_ROOT, "docs", "developer")),
  ...walkFiles(join(REPOSITORY_ROOT, "examples")),
  // The kit's own tests — EXCLUDING this file, which contains the
  // detection patterns themselves (a detector necessarily matches its
  // own regex definitions; every other kit file stays in scope).
  ...walkFiles(join(REPOSITORY_ROOT, "tests", "unit", "developer-docs")).filter(
    (file) => !file.endsWith("secret-scan.test.ts"),
  ),
];

/** The credential-shaped literal patterns (mirrors deploy/lib.ts). */
const PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: "URL-embedded credentials (scheme://user:password@host)",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i,
  },
  { name: "OpenAI-style key literal", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub token literal", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key literal", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token literal", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "credential assignment (token/secret/password/api_key = value)",
    pattern: /["'](token|secret|password|api[_-]?key)["']\s*:\s*["'][^"']{12,}["']/i,
  },
  {
    name: "provider key prefix literal (sk-or-v1/sk-proj/sk-ws/apikey-/ak_/ck_)",
    pattern:
      /(sk-or-v1-|sk-proj-|sk-ws-|apikey-[A-Za-z0-9]{8}|ak_[A-Za-z0-9]{8}|ck_[A-Za-z0-9]{8})/,
  },
  {
    name: "bearer literal with long token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  },
];

describe("no secret value is embedded anywhere in the integration kit", () => {
  test("the scan discovered kit files", () => {
    expect(KIT_FILES.length).toBeGreaterThanOrEqual(50);
  });

  test("no file contains a credential-shaped literal", () => {
    const violations: string[] = [];
    for (const file of KIT_FILES) {
      const content = readFileSync(file, "utf8");
      for (const { name, pattern } of PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file.slice(REPOSITORY_ROOT.length + 1)}: ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("credential NAMES are present (the contract documents names, never values)", () => {
    const envContract = readFileSync(
      join(REPOSITORY_ROOT, "docs", "developer", "machine", "env-vars.json"),
      "utf8",
    );
    for (const name of ["OPENROUTER_API_KEY", "QWEN_API_KEY", "ZECK_TOKEN"]) {
      expect(envContract).toContain(name);
    }
    // And the token variable is documented as credential-shaped.
    expect(envContract).toContain('"credentialShaped": true');
  });
});
