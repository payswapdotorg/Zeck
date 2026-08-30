/**
 * Coordination port (Redis 7+).
 *
 * Redis is never the durable authority — durable state belongs to the
 * database (`IMPLEMENTATION.md` §1). This port exists only for locks and
 * ephemeral cache/coordination semantics where a durable database
 * transaction is not the authority.
 */
export interface CoordinationPort {
  /**
   * Attempt to acquire a lock. Returns `null` when the lock is held
   * elsewhere. `LockHandle.release` is idempotent.
   */
  acquireLock(key: string, ttlMs: number): Promise<LockHandle | null>;

  get(key: string): Promise<string | null>;

  set(key: string, value: string, ttlMs: number): Promise<void>;

  delete(key: string): Promise<void>;
}

export interface LockHandle {
  readonly key: string;
  release(): Promise<void>;
}
