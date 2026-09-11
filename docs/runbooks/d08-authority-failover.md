# D-08 runbook — HA authority failover (PostgreSQL primary + standby)

**Scenario:** the authoritative PostgreSQL PRIMARY for an environment
is lost while a streaming STANDBY exists. The governed failover
promotes the standby and repoints the control plane; the D-07
invariant-gate restore proof must pass IDENTICALLY on the promoted
authority. Recovery RESTORES authority from the standby's replicated
state — it never reconstructs it from providers; PostgreSQL remains
the SOLE durable authority (AVA-002; WORK-057 / D-08).

**Tool:** `bun run deploy:drill authority-failover --environment <env> [--primary-port <p>] [--standby-port <p>] [--keep-topology] [--loss-at <iso8601>]`

## Preconditions

### The local drill form (safe disposable topology)

- `ZECK_PG_ADMIN_URL` is materialized (the LIVE local authority —
  `zeck_local`, migrated; the drill only READS it through the D-07
  backup engine and never touches it).
- Local PostgreSQL 16+ **server binaries** are available:
  `ZECK_HA_POSTGRES_BIN` (a bin directory containing `postgres` and
  `initdb`) or on `PATH`. No binaries ⇒ an honest fail-closed error —
  a simulated topology is never an option.
- The drill ports (`--primary-port` / `--standby-port`, defaults
  55601/55602) must be free.

### The operator topology form (preview / staging / production)

- The environment's HA endpoints are materialized:
  `ZECK_HA_PRIMARY_URL` and `ZECK_HA_STANDBY_URL` (credential-shaped,
  environment-only — never committed), optionally
  `ZECK_HA_REPLICATION_MODE` (`asynchronous` default; selects the
  replication-path RPO target the measured RPO is evaluated against).
- **The operator FENCES the lost primary FIRST** (stop it, revoke its
  write access, or isolate it at the network layer). The drill's
  split-brain guard refuses to promote while the primary is
  reachable — that refusal is CORRECT behavior; a promotion against a
  live primary would create two writable authorities.
- For a REAL loss: pass `--loss-at <iso8601>` (the recorded instant
  the primary was declared lost) so the measured RTO/RPO anchor
  honestly; the default is the drill start (the conservative operator
  clock).

## The procedure (what the tool runs)

**Local (disposable):** the drill builds a REAL primary + REAL
standby pair (initdb, production startup/migrations, the D-07
backup→restore of the live authority's state into the disposable
primary, the manual base-backup standby bootstrap, streaming
readiness, LSN catch-up gate) — then executes the failover itself:

1. **Loss** — the disposable primary is SIGKILLed (the unplanned-loss
   form; the LIVE local authority is never touched).
2. **Promotion** — the governed failover executor: fail-closed
   preconditions (primary unreachable — repeated-probe consensus;
   standby in recovery) then `pg_promote`; post-conditions (out of
   recovery, writable, primary still unreachable).
3. **Repoint** — the control plane's production startup path
   (connect + version gate + migrations + schema convergence) runs
   against the PROMOTED authority.
4. **Invariant gate** — the D-07 12-check recovered-authority proof,
   IDENTICALLY green after failover.
5. **Replay classification** — the durable dispatch-envelope plan
   from the promoted authority (AVA-004: replay converges through the
   EXISTING dispatch/execution idempotency; the in-flight
   convergence with zero duplicated side effects is executed by the
   HA integration drill over the same machinery).
6. **Fail-closed proof** — the control plane REFUSES to serve against
   the dead primary (typed `DatabaseUnavailableError`); correct
   behavior, measured as such.
7. **Idempotence** — re-running the failover against the
   already-promoted topology is a bounded no-op.
8. **Cleanup** — the disposable topology is disposed (unless
   `--keep-topology`).

**Provider environments:** the same machinery against the declared
endpoints (readiness probe → promotion → invariant gate → replay
classification). Live provider-managed HA control planes (automatic
failover APIs) are NOT absorbed and are NOT RUN by this drill —
disclosed exactly (the SELF-HOSTING boundary).

## Success criteria

- Every phase `ok: true` and `drill.recovered: true` (exit 0).
- `objectives.evaluation.rtoWithinTarget` and `rpoWithinTarget` are
  true against the environment's **HA failover targets** in
  `deploy/manifests/recovery-targets.json` (`ha.failover.rtoTargetMs`
  + the replication-path `ha.replication[mode].rpoTargetMs`;
  production class: RTO ≤ 15 minutes, async RPO ≤ 60 s / sync 0).
- The measured RPO anchor for the local drill is the loss instant
  (the LSN catch-up gate proves the standby replayed the primary's
  final WAL position and the drill writes nothing between catch-up
  and loss — zero data at risk); the at-risk window and the probe lag
  are recorded as supplementary evidence.

## Failure handling (fail-closed)

- **"the primary authority is still reachable"** — the split-brain
  guard: the primary was not fenced. Fence it (stop / isolate) and
  re-run; NEVER force a promotion against a live primary.
- **"not a converged Zeck authority"** — the endpoint at the standby
  address is not the recovered authority (foreign database or drifted
  schema): failover restores authority, it never constructs one.
  Re-check the endpoint and the standby's bootstrap.
- Invariant violations → the promoted authority is not authoritative
  state; the environment is NOT recovered, whatever the provider
  dashboards say. Re-bootstrap the standby and re-run.
- RTO/RPO breach → the drill exits 1 with the measured numbers and
  the breach text; investigate the slow phase before claiming the
  objectives.
- Standby did not catch up / attach within the bounded window → the
  replication path is broken; fix replication before any failover
  (a lagging standby is a measurable RPO risk, not a drill failure to
  hide).

## Replay convergence after failover (AVA-004)

After the failover, in-flight governed work converges through the
EXISTING machinery — never provider-side dedup:

- executions whose dispatch envelope is `published`-unapplied are
  **re-driven from the authority** (the worker-fabric recovery scan;
  a fresh worker over the promoted authority abandons the stale
  claims, fresh lease epochs, executes exactly once);
- envelopes `recorded`/`backlogged` are **republished** by the
  durable dispatcher (`republishPending` reads PostgreSQL only);
- the drill's replay phase records the durable classification; the
  executed proof (zero duplicated side effects: exactly one provider
  dispatch and exactly one `execution.pass` per in-flight execution,
  pre-loss ledgers as a strict prefix of the post-failover ledgers)
  is the HA integration drill
  (`tests/integration/postgres/ha-failover.test.ts`).
