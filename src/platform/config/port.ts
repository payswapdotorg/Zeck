/**
 * Platform configuration contract.
 *
 * Infrastructure endpoints are ordinary configuration. Provider credentials
 * are NOT configuration values: they are opaque `SecretReference`s resolved
 * through the secret store after policy admission (`IMPLEMENTATION.md` §9).
 * The adapter that loads configuration from the environment arrives with the
 * Work Order that first needs it.
 */
export interface PlatformConfig {
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly objectStorage: ObjectStorageConfig;
}

export interface DatabaseConfig {
  /** PostgreSQL 16+ connection endpoint. */
  readonly url: string;
}

export interface RedisConfig {
  /** Redis 7+ endpoint used only for coordination/ephemeral cache. */
  readonly url: string;
}

export interface ObjectStorageConfig {
  /** S3-compatible bucket name behind the `ObjectStore` port. */
  readonly bucket: string;
}

export interface ConfigPort {
  load(): Promise<PlatformConfig>;
}
