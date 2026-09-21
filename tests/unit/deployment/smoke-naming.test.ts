/**
 * Unit — the deploy/smoke preview-branch naming regression (PPR-004
 * finding F2).
 *
 * The live credentialed preview run (2026-09-21, revision 9915be6)
 * proved the defect: `deploy:smoke --environment preview --branch
 * main`'s artifact-bytes cross-check called `computeResourceNames`
 * WITHOUT the preview branch slug while the same run's identity
 * document named the per-branch bucket `zeck-preview-main-artifacts`
 * — so a correctly-named, reachable per-branch bucket was reported as
 * drift (`zeck-preview-main-artifacts != zeck-preview-artifacts`) and
 * the concern read `unavailable`.
 *
 * These pins prove the fix over the REAL manifest set and a REAL
 * local object-store endpoint (an in-process HEAD server standing in
 * for the R2 endpoint the S3 adapter probes):
 *  - the per-branch expected name computes as
 *    `zeck-preview-main-artifacts` (the regression's expected value);
 *  - the full smoke attestation with `--branch main` reports the
 *    correctly-named per-branch bucket READY (no drift) while the
 *    same attestation's identity document carries the SAME per-branch
 *    name (identity and probe comparison agree);
 *  - the drift check still catches a GENUINELY mis-named bucket (the
 *    fix threads the slug; it does not weaken the check).
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runSmokeAttestation } from "../../../deploy/smoke";
import { namingConventionsOf } from "../../../src/platform/deployment/identity";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { computeResourceNames } from "../../../src/platform/deployment/naming";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

describe("the smoke artifact-name drift check threads the preview branch slug (PPR-004 F2)", () => {
  test("REGRESSION: the per-branch expected bucket name over the real manifest is zeck-preview-main-artifacts", () => {
    const manifest = loadReal();
    const conventions = namingConventionsOf(manifest);
    // With the branch slug (what --branch main produces, and what the
    // identity document has always named):
    const perBranch = computeResourceNames(
      conventions,
      "preview",
      manifest.resources.preview,
      "main",
    );
    expect(perBranch.find((n) => n.kind === "r2-bucket")?.name).toBe("zeck-preview-main-artifacts");
    // Without the branch slug (the omission that produced the false
    // drift): a DIFFERENT name — which is exactly why the slug must be
    // threaded through the comparison.
    const slugless = computeResourceNames(conventions, "preview", manifest.resources.preview);
    expect(slugless.find((n) => n.kind === "r2-bucket")?.name).toBe("zeck-preview-artifacts");
  });

  describe("the full attestation (--branch main, a reachable per-branch bucket)", () => {
    let server: Server;
    let endpoint: string;
    const savedEnv: Record<string, string | undefined> = {};

    const setEnv = (name: string, value: string | undefined): void => {
      savedEnv[name] = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };

    beforeAll(async () => {
      // A minimal object-store endpoint: every HEAD answers 200 (the
      // S3 adapter's headBucket probe — signature details are not
      // relevant to the naming check).
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end();
      });
      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      endpoint = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    });

    const materializePreviewObjectStore = (bucket: string): void => {
      setEnv("ZECK_ENVIRONMENT", "preview");
      setEnv(
        "ZECK_SECRET_OBJECT_STORE_ACCESS_KEY_ID_REF",
        "zeck-secret://preview/object-store-access-key-id",
      );
      setEnv(
        "ZECK_SECRET_OBJECT_STORE_SECRET_ACCESS_KEY_REF",
        "zeck-secret://preview/object-store-secret-access-key",
      );
      setEnv("ZECK_OBJECT_STORE_ACCESS_KEY_ID", "test-access-key-id");
      setEnv("ZECK_OBJECT_STORE_SECRET_ACCESS_KEY", "test-secret-access-key");
      setEnv("ZECK_OBJECT_STORE_ENDPOINT", endpoint);
      setEnv("ZECK_OBJECT_STORE_BUCKET", bucket);
      setEnv("ZECK_OBJECT_STORE_REGION", "auto");
    };

    const artifactDependency = async (
      branch: string | undefined,
    ): Promise<{ status: string; detail: string | null; identity: unknown }> => {
      const attestation = await runSmokeAttestation(
        "preview",
        branch === undefined ? {} : { branch },
      );
      const dependency = attestation.readiness.dependencies.find(
        (entry) => entry.concern === "artifact-bytes",
      );
      expect(dependency).toBeDefined();
      return {
        status: dependency?.status ?? "",
        detail: dependency?.detail ?? null,
        identity: attestation.identity,
      };
    };

    test("REGRESSION: a correctly-named per-branch bucket (zeck-preview-main-artifacts) reports ready, not drift", async () => {
      materializePreviewObjectStore("zeck-preview-main-artifacts");
      // The exact live-run configuration that read `unavailable`
      // before the fix: --environment preview --branch main.
      const result = await artifactDependency("main");
      expect(result.status).toBe("ready");
      expect(result.detail).toContain("zeck-preview-main-artifacts");
      // And the SAME attestation's identity document names the SAME
      // per-branch resource (identity and drift comparison agree —
      // the inconsistency that produced the false drift is gone).
      expect(JSON.stringify(result.identity)).toContain("zeck-preview-main-artifacts");
    });

    test("the drift check still catches a genuinely mis-named bucket (the fix threads the slug, it does not weaken the check)", async () => {
      // A bucket carrying the SLUGLESS name under --branch main: a
      // real naming defect (the manifest computes the per-branch name
      // for every per-branch resource) — must still read as drift.
      materializePreviewObjectStore("zeck-preview-artifacts");
      const result = await artifactDependency("main");
      expect(result.status).toBe("unavailable");
      expect(result.detail).toContain(
        "drifts from the manifest-computed resource name (zeck-preview-artifacts != zeck-preview-main-artifacts)",
      );
    });
  });
});
