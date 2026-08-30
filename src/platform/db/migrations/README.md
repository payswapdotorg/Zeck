# SQL Migrations

Forward-only SQL migrations live under this directory (`IMPLEMENTATION.md` §1).
Migrations are never edited after merge; corrections are new migrations.

The migration runner (`runner.ts`, WORK-002) applies files named
`NNNN_name.sql` in ascending version order, exactly once each, recording
`(version, name, sha256 checksum, applied_at)` in `platform.schema_migrations`
inside the same transaction as the migration. A modified, renamed or reordered
already-applied migration fails closed. Concurrent runners serialize on a
PostgreSQL advisory lock. `runMigrations(db, files)` is pure over the
provider-neutral `DatabasePort`; `applyShippedMigrations(db)` loads and applies
the files in this directory.
