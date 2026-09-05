/**
 * Fail-closed error taxonomy for the database platform adapters
 * (WORK-043 / D-02).
 *
 * Every message in this taxonomy is SAFE BY CONSTRUCTION: connection
 * strings and credential material never enter an error message —
 * diagnostics are redacted at the construction sites (the
 * `pg`-adapter connect path and the startup validation path both pass
 * through `redactConnectionString` before wrapping).
 */

/** The authoritative PostgreSQL endpoint is unreachable or unusable. */
export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * Startup validation failed closed: the database is reachable but the
 * authoritative state is incompatible (server version below the
 * PostgreSQL 16 floor, non-deterministic migration history, schema
 * not converged with the shipped migrations).
 */
export class StartupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupValidationError";
  }
}

/**
 * Backup/restore verification failed: the recovered state does not
 * match the recorded checksums or the migration history is
 * inconsistent with the backup artifact.
 */
export class RestoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreVerificationError";
  }
}
