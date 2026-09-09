# D-07 runbook — artifact store exit (R2 → alternate S3-compatible)

**Scenario:** the artifact-bytes provider (e.g. Cloudflare R2) must be
replaced by any other S3-compatible object store — provider exit,
pricing incident, regional loss. PostgreSQL keeps the artifact
METADATA authority (the adoption ledger: keys, digests, lineage,
deployment chain); the object store only ever holds BYTES at
content-addressed keys (`zeck/artifacts/<tenant>/<shard>/<digest>`).

**Tool:** `bun run deploy:drill artifact-exit --env <environment>`

## Preconditions

The alternate (substitution-target) store's configuration must be
materialized in the environment (credential-shaped values are
environment-only, never committed):

- `ZECK_DRILL_ALTERNATE_OBJECT_STORE_ENDPOINT`
- `ZECK_DRILL_ALTERNATE_OBJECT_STORE_BUCKET`
- `ZECK_DRILL_ALTERNATE_OBJECT_STORE_REGION`
- `ZECK_DRILL_ALTERNATE_OBJECT_STORE_ACCESS_KEY_ID`
- `ZECK_DRILL_ALTERNATE_OBJECT_STORE_SECRET_ACCESS_KEY`

The operative (exiting) store's endpoint resolves from the
environment's object-store configuration
(`ZECK_OBJECT_STORE_*` + the environment secret materialization).
Missing configuration is an honest **NOT RUN** (exit 2) — never a
PASS.

## The procedure (what the tool runs)

1. **Inventory scan** — read the authoritative adoption ledger from
   PostgreSQL (the recovery plan is EXACTLY the ledger; provider
   listings are never consulted; extra foreign bytes in a store are
   invisible to recovery).
2. **Byte migration** — for every inventory entry: read the bytes at
   the content-addressed key from the exiting store, verify the
   sha256 digest against the authority, write to the alternate at the
   SAME content-addressed key, verify read-after-write. Fail-closed
   on: missing source bytes (unrecoverable loss), source content
   drift, target identity collision (different bytes already at the
   key — never overwritten).
3. **Target verification** — the alternate store verifies against the
   authority (content identity) and the lineage binding holds (every
   entry's chain still resolves in PostgreSQL).

Switching the environment over afterwards is configuration only:
point the object-store variables at the alternate endpoint and
credentials. No code changes, no domain semantics, no re-keying
(keys are digest-derived).

## Success criteria

- `migration.completed: true` with zero failures; re-running reports
  `alreadyIntact` for every entry (idempotent — safe to re-run).
- `targetVerification.recovered: true` and `lineage.preservedAll: true`.
- Objectives within the environment target (exit 0).

## Failure handling (fail-closed)

- "bytes missing at the independent source store" — the exiting
  provider no longer holds those bytes and no other retained copy
  exists: that artifact is LOST (reported, never silently dropped).
  Restore bytes from an independent retained copy (replica/operator
  backup) and re-run.
- "target identity collision" — the alternate store already holds
  different bytes at a content-addressed key: STOP and investigate
  (the target's integrity is suspect); the tool never overwrites.
- The local protocol-level evidence is produced by the integration
  suite (`tests/integration/postgres/recovery-artifact-exit.test.ts`
  over two real S3-compatible endpoints); live R2/alternate endpoints
  are proven by executing this drill with real credentials (NOT RUN
  until then — never claimed).
