/**
 * `tools` internal layer — implementation details that must never be imported by another
module — not directly and not via re-export (`IMPLEMENTATION.md` §2).
 */

export interface AsyncLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serialization lock for in-memory registry arbitration (the capabilities
 * module's internal-lock pattern, reimplemented module-locally — internal
 * utilities are never shared across module boundaries).
 */
export function createAsyncLock(): AsyncLock {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const next = tail.then(operation);
      // The chain must never reject: failures are the caller's outcome.
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
