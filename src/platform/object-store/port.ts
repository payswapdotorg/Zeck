/**
 * Object storage port (S3-compatible storage behind an owned port,
 * `IMPLEMENTATION.md` §1). Durable artifacts are stored and retrieved by
 * reference; content is opaque bytes at this boundary.
 */
export interface ObjectStorePort {
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<void>;

  /** Returns `null` when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;

  delete(key: string): Promise<void>;
}

export interface PutOptions {
  readonly contentType?: string;
}

export interface StoredObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
}
