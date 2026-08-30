/**
 * Discrimination tests for the dependency boundaries (WORK-001).
 *
 * The Work Order requires discrimination/mutation proof for every CRITICAL
 * safety boundary it names. Each test injects a synthetic violation and
 * asserts the rule engine REJECTS it — proving the architecture tests are
 * discriminating protections, not vacuous checks. The final block is the
 * negative control: a fully valid synthetic project produces zero
 * violations, including SDK imports at their owning adapter.
 */
import { describe, expect, test } from "vitest";
import { type SourceFile, scanDependencyRules } from "../architecture/lib/dependency-rules";

function file(path: string, ...imports: string[]): SourceFile {
  const statements = imports.map((specifier) => `import "${specifier}";`).join("\n");
  return { path, content: `${statements}\nexport {};\n` };
}

/** Minimal valid project skeleton shared by all cases. */
function validProject(): SourceFile[] {
  return [
    file("src/shared/module.ts"),
    file("src/shared/errors.ts"),
    file("src/platform/db/port.ts"),
    file("src/platform/clock/port.ts"),
    file("src/modules/auth/public.ts", "../../shared/module"),
    file("src/modules/auth/domain/index.ts", "../../../shared/module"),
    file("src/modules/auth/application/index.ts", "../domain", "../ports"),
    file("src/modules/auth/ports/index.ts", "../domain"),
    file("src/modules/auth/adapters/index.ts", "../ports", "../../../platform/db/port"),
    file("src/modules/auth/internal/index.ts", "../domain"),
    file("src/modules/executions/public.ts", "../../shared/module"),
    file("src/modules/executions/domain/index.ts"),
    file("src/modules/executions/internal/index.ts"),
  ];
}

function violationsFor(files: SourceFile[], allowedPackages: readonly string[] = []) {
  return scanDependencyRules(files, { allowedPackages });
}

describe("discrimination: cross-module internal imports are rejected", () => {
  test("a module importing another module's internal/ is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/internal/queue.ts"),
      file("src/modules/auth/application/index.ts", "../domain", "../../executions/internal/queue"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/auth/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "internal-never-cross-module")).toBe(true);
  });

  test("the api layer importing a module's internal/ is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/internal/queue.ts"),
      file("src/api/server.ts", "../modules/executions/internal/queue"),
    ];
    const violations = violationsFor(files).filter((v) => v.path === "src/api/server.ts");
    expect(violations.some((v) => v.rule === "internal-never-cross-module")).toBe(true);
    expect(violations.some((v) => v.rule === "api-boundary")).toBe(true);
  });

  test("the workflowos integration's internal/ is protected the same way", () => {
    const files = [
      ...validProject(),
      file("src/integrations/workflowos/public.ts"),
      file("src/integrations/workflowos/internal/client.ts"),
      file(
        "src/modules/tools/application/index.ts",
        "../../../integrations/workflowos/internal/client",
      ),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/tools/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "internal-never-cross-module")).toBe(true);
  });
});

describe("discrimination: cross-module imports must use the public barrel", () => {
  test("importing another module's domain layer is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/domain/entities.ts"),
      file(
        "src/modules/auth/application/index.ts",
        "../domain",
        "../../executions/domain/entities",
      ),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/auth/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "cross-module-public-only")).toBe(true);
  });

  test("importing another module's adapters is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/adapters/repo.ts"),
      file("src/modules/auth/internal/index.ts", "../../executions/adapters/repo"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/auth/internal/index.ts",
    );
    expect(violations.some((v) => v.rule === "cross-module-public-only")).toBe(true);
  });
});

describe("discrimination: domains stay decoupled from infrastructure", () => {
  test("a domain layer importing src/platform is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/domain/index.ts", "../../../platform/clock/port"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/domain/index.ts",
    );
    expect(violations.some((v) => v.rule === "domain-coupled-to-platform")).toBe(true);
  });

  test("an application layer importing src/platform is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/application/index.ts", "../../../platform/db/port"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "domain-coupled-to-platform")).toBe(true);
  });

  test("a ports layer importing src/platform is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/ports/index.ts", "../../../platform/clock/port"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/ports/index.ts",
    );
    expect(violations.some((v) => v.rule === "domain-coupled-to-platform")).toBe(true);
  });

  test("a public barrel importing src/platform is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/public.ts", "../../platform/db/port"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/public.ts",
    );
    expect(violations.some((v) => v.rule === "public-contract-purity")).toBe(true);
  });

  test("domain layers importing HTTP/process runtime modules are caught", () => {
    const files = [...validProject(), file("src/modules/executions/domain/index.ts", "node:http")];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/domain/index.ts",
    );
    expect(violations.some((v) => v.rule === "domain-runtime-import")).toBe(true);
  });
});

describe("discrimination: layer direction and isolation zones", () => {
  test("application importing its own adapters is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/adapters/repo.ts"),
      file("src/modules/executions/application/index.ts", "../adapters/repo"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "module-layer-direction")).toBe(true);
  });

  test("domain importing its own application layer is caught", () => {
    const files = [
      ...validProject(),
      file("src/modules/executions/application/usecase.ts"),
      file("src/modules/executions/domain/index.ts", "../application/usecase"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/executions/domain/index.ts",
    );
    expect(violations.some((v) => v.rule === "module-layer-direction")).toBe(true);
  });

  test("platform importing a module is caught", () => {
    const files = [
      ...validProject(),
      file("src/platform/config/port.ts", "../../modules/executions/public"),
    ];
    const violations = violationsFor(files).filter((v) => v.path === "src/platform/config/port.ts");
    expect(violations.some((v) => v.rule === "platform-isolation")).toBe(true);
  });

  test("shared importing a module is caught", () => {
    const files = [...validProject(), file("src/shared/errors.ts", "../modules/auth/public")];
    const violations = violationsFor(files).filter((v) => v.path === "src/shared/errors.ts");
    expect(violations.some((v) => v.rule === "shared-isolation")).toBe(true);
  });

  test("a module importing the api layer is caught", () => {
    const files = [
      ...validProject(),
      file("src/api/server.ts"),
      file("src/modules/auth/internal/index.ts", "../../../api/server"),
    ];
    const violations = violationsFor(files).filter(
      (v) => v.path === "src/modules/auth/internal/index.ts",
    );
    expect(violations.some((v) => v.rule === "module-imports-api")).toBe(true);
  });

  test("an api file importing platform or module internals is caught", () => {
    const files = [
      ...validProject(),
      file("src/api/server.ts", "../modules/auth/public", "../platform/db/port"),
    ];
    const violations = violationsFor(files).filter((v) => v.path === "src/api/server.ts");
    expect(violations.some((v) => v.rule === "api-boundary")).toBe(true);
  });
});

describe("discrimination: provider SDKs live only inside owning adapters", () => {
  test("openai imported by a tools domain file is caught", () => {
    const files = [...validProject(), file("src/modules/tools/domain/index.ts", "openai")];
    const violations = violationsFor(files, ["openai"]).filter(
      (v) => v.path === "src/modules/tools/domain/index.ts",
    );
    expect(violations.some((v) => v.rule === "provider-sdk-outside-adapter")).toBe(true);
  });

  test("pg imported by an auth application file is caught", () => {
    const files = [...validProject(), file("src/modules/auth/application/index.ts", "pg")];
    const violations = violationsFor(files, ["pg"]).filter(
      (v) => v.path === "src/modules/auth/application/index.ts",
    );
    expect(violations.some((v) => v.rule === "provider-sdk-outside-adapter")).toBe(true);
  });

  test("fastify imported by a module domain file is caught (owned by api transport)", () => {
    const files = [...validProject(), file("src/modules/executions/domain/index.ts", "fastify")];
    const violations = violationsFor(files, ["fastify"]).filter(
      (v) => v.path === "src/modules/executions/domain/index.ts",
    );
    expect(violations.some((v) => v.rule === "provider-sdk-outside-adapter")).toBe(true);
  });

  test("an undeclared package import in src/ fails closed", () => {
    const files = [...validProject(), file("src/shared/util.ts", "lodash-es")];
    const violations = violationsFor(files).filter((v) => v.path === "src/shared/util.ts");
    expect(violations.some((v) => v.rule === "undeclared-package-import")).toBe(true);
  });

  test("a declared SDK at its owning adapter is NOT flagged (negative control)", () => {
    const files = [...validProject(), file("src/modules/models/adapters/openrouter.ts", "openai")];
    const violations = violationsFor(files, ["openai"]).filter((v) =>
      v.path.endsWith("adapters/openrouter.ts"),
    );
    expect(violations).toEqual([]);
  });
});

describe("discrimination: relative imports must resolve", () => {
  test("a dangling relative import is caught", () => {
    const files = [...validProject(), file("src/modules/auth/public.ts", "./missing")];
    const violations = violationsFor(files).filter((v) => v.path === "src/modules/auth/public.ts");
    expect(violations.some((v) => v.rule === "import-resolution")).toBe(true);
  });
});

describe("negative control: a valid project shape produces zero violations", () => {
  test("all legal import shapes pass simultaneously", () => {
    const files = [
      ...validProject(),
      // cross-module public import from application layer — legal
      file("src/modules/auth/application/index.ts", "../domain", "../../executions/public"),
      // api composing public barrels and shared — legal
      file("src/api/server.ts", "../modules/auth/public", "../shared/errors"),
      // adapter using platform + own ports — legal
      file("src/modules/auth/adapters/index.ts", "../ports", "../../../platform/db/port"),
      // internal implementation importing own domain — legal
      file("src/modules/auth/internal/index.ts", "../domain"),
      // declared SDK at its owning adapter — legal
      file("src/modules/models/adapters/openrouter.ts", "openai"),
    ];
    expect(violationsFor(files, ["openai"])).toEqual([]);
  });
});
