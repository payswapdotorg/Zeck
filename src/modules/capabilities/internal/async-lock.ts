/**
 * Serialization lock for in-memory registry arbitration (capabilities
 * module internal — never imported from outside this module).
 *
 * Publish operations mutate the arbitrated catalog; the lock makes every
 * validate→arbitrate→insert sequence ATOMIC with respect to other
 * publishes (the in-memory equivalent of a transaction: concurrent
 * identical publishes converge to one accepted record + revision, and no
 * arbitration decision observes a half-applied publish).
 */
export interface AsyncLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

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
