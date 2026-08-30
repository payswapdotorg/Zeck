/**
 * Env-gated suite helper: registers the suite normally when `url` is set,
 * otherwise registers an explicitly skipped placeholder test (visible in CI
 * output — honesty over silence).
 *
 * The context handed to `register` is a MUTABLE object filled by `beforeAll`;
 * reading its properties at collection time yields undefined by design.
 * Tests must resolve their context inside the test body.
 */

import { afterAll, beforeAll, describe, test } from "vitest";

export type SuiteSetup<T> = (
  adminUrl: string,
) => Promise<{ context: T; cleanup: () => Promise<void> }>;

export function defineSuite<T extends object>(
  name: string,
  url: string,
  register: (ctx: T) => void,
  setup: SuiteSetup<T>,
): void {
  if (!url) {
    describe(name, () => {
      test.skip("suite requires ZECK_PG_TEST_URL (real PostgreSQL) — run locally with the embedded server; see docs/work-items/WORK-002.md", () => {});
    });
    console.info(
      `[pg-suite] "${name}" SKIPPED: ZECK_PG_TEST_URL is not set (no real PostgreSQL configured)`,
    );
    return;
  }

  describe(name, () => {
    const ctx = {} as T;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const prepared = await setup(url);
      Object.assign(ctx, prepared.context);
      cleanup = prepared.cleanup;
    });

    afterAll(async () => {
      await cleanup?.();
    });

    register(ctx);
  });
}
