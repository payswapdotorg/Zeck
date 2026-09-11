/**
 * deploy/ha — the local disposable HA topology lifecycle (WORK-057 /
 * D-08, AVA-002; the operator tooling behind `deploy:drill
 * authority-failover --environment local`).
 *
 * THE SAFE OPERATOR FORM (the D-07 `authority-loss` precedent,
 * extended to the HA topology): the LIVE local authority
 * (`zeck_local`) is NEVER touched — it is read once through the D-07
 * logical-backup engine; the drill then builds a DISPOSABLE
 * primary + standby pair (real PostgreSQL 16+ instances, real
 * streaming replication), fails over between them, and tears the
 * topology down. The same failover machinery (replication probe +
 * failover executor + invariant gate) runs against operator-managed
 * topologies in the provider environments through
 * `ZECK_HA_PRIMARY_URL`/`ZECK_HA_STANDBY_URL` — provider-managed HA
 * control planes are NEVER absorbed (the SELF-HOSTING-BOUNDARY; live
 * provider HA APIs are NOT RUN and disclosed exactly).
 *
 * STANDBY BOOTSTRAP is the documented manual base-backup procedure as
 * pure repository code: `pg_backup_start` → filesystem copy of the
 * primary's data directory → `pg_backup_stop` → `backup_label` +
 * `tablespace_map` → `standby.signal` + `primary_conninfo` → start the
 * standby server → wait for streaming. No `pg_basebackup` binary is
 * required; every step is either SQL through the `pg` driver or a
 * filesystem copy of a directory this tool owns.
 *
 * PostgreSQL binaries resolve from `ZECK_HA_POSTGRES_BIN` (a bin
 * directory) or PATH; a missing binary is an honest configuration
 * failure — never a simulated topology.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Client } from "pg";
import { redactConnectionString } from "../src/platform/db/connection";
import { PgReplicationProbe } from "../src/platform/db/ha/replication";

/** Fail-closed local-topology error (honest, never a simulated PASS). */
export class LocalHaTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalHaTopologyError";
  }
}

export interface PostgresBinaries {
  readonly postgres: string;
  readonly initdb: string;
}

/**
 * Resolve PostgreSQL server binaries: `ZECK_HA_POSTGRES_BIN` (a bin
 * directory containing `postgres` + `initdb`) or PATH lookup. Fail
 * closed with the honest operator guidance when unavailable.
 */
export function resolvePostgresBinaries(env: Record<string, string | undefined>): PostgresBinaries {
  const declared = env.ZECK_HA_POSTGRES_BIN;
  if (declared !== undefined && declared.length > 0) {
    const postgres = `${declared}/postgres`;
    const initdb = `${declared}/initdb`;
    if (!existsSync(postgres) || !existsSync(initdb)) {
      throw new LocalHaTopologyError(
        `ZECK_HA_POSTGRES_BIN does not contain postgres/initdb binaries (found: ${postgres})`,
      );
    }
    return { postgres, initdb };
  }
  // PATH lookup (spawn resolves "postgres" from PATH).
  const probe = spawnSync("postgres", ["--version"], { encoding: "utf8" });
  const initdbProbe = spawnSync("initdb", ["--version"], { encoding: "utf8" });
  if (
    probe.error !== undefined ||
    probe.status !== 0 ||
    initdbProbe.error !== undefined ||
    initdbProbe.status !== 0
  ) {
    throw new LocalHaTopologyError(
      "no local PostgreSQL binaries are available (set ZECK_HA_POSTGRES_BIN to a PostgreSQL 16+ bin directory, or put postgres/initdb on PATH); the local HA drill requires REAL primary + standby instances — never a simulation",
    );
  }
  return { postgres: "postgres", initdb: "initdb" };
}

/** One locally-managed PostgreSQL server (drill-owned, disposable). */
export interface LocalHaServer {
  readonly dataDir: string;
  readonly port: number;
  readonly adminUrl: string;
  readonly logsPath: string;
  readonly child: ChildProcess;
  /** The URL of one database on this server. */
  urlFor(database: string): string;
  /** Terminate the server: mode 'kill' = the loss instant (SIGKILL); 'stop' = graceful teardown. */
  terminate(mode: "kill" | "stop"): Promise<void>;
  /** Remove the data directory (teardown; never the live authority). */
  dispose(): void;
}

const VOLATILE_SUBDIRS = [
  "pg_dynshmem",
  "pg_notify",
  "pg_serial",
  "pg_snapshots",
  "pg_stat_tmp",
] as const;

function terminateChild(child: ChildProcess, mode: "kill" | "stop"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const signal = mode === "kill" ? "SIGKILL" : "SIGTERM";
    const timer = setTimeout(() => {
      // Fast-shutdown fallback for a stubborn graceful stop.
      try {
        child.kill("SIGKILL");
      } catch {
        void signal;
      }
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill(signal);
    } catch (error) {
      clearTimeout(timer);
      reject(
        new LocalHaTopologyError(
          `failed to ${mode} the server process: ${(error as Error).message}`,
        ),
      );
    }
  });
}

async function waitForAcceptance(url: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // Already disconnected.
      }
      if (Date.now() >= deadline) {
        throw new LocalHaTopologyError(
          `${what} did not accept connections within ${timeoutMs}ms (see the server log under the data directory)`,
        );
      }
      await sleep(250);
    }
  }
}

/** Assert a TCP port is free (a server bound there would break the drill). */
export async function assertPortFree(port: number): Promise<void> {
  const client = new Client({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    connectionTimeoutMillis: 500,
  });
  try {
    await client.connect();
    await client.end();
    throw new LocalHaTopologyError(
      `port ${port} already accepts PostgreSQL connections (choose free --primary-port/--standby-port values)`,
    );
  } catch (error) {
    if (error instanceof LocalHaTopologyError) {
      throw error;
    }
    // Refused = free, as required.
  }
}

/** Start the postgres PROCESS on an existing, configured data directory. */
async function spawnPostgresServer(options: {
  readonly dataDir: string;
  readonly port: number;
  readonly binaries: PostgresBinaries;
  readonly label: string;
}): Promise<LocalHaServer> {
  const logsPath = `${options.dataDir}/zeck-ha-server.log`;
  const child = spawn(options.binaries.postgres, ["-D", options.dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = createWriteStream(logsPath, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  const server: LocalHaServer = {
    dataDir: options.dataDir,
    port: options.port,
    adminUrl: `postgres://postgres@127.0.0.1:${options.port}/postgres`,
    logsPath,
    child,
    urlFor: (database) => `postgres://postgres@127.0.0.1:${options.port}/${database}`,
    terminate: (mode) => terminateChild(child, mode),
    dispose: () => {
      rmSync(options.dataDir, { recursive: true, force: true });
    },
  };
  await waitForAcceptance(server.adminUrl, 60_000, `the ${options.label} server`);
  return server;
}

/** Start one disposable local PostgreSQL server (initdb + spawn + readiness). */
export async function startLocalPostgresServer(options: {
  readonly dataDir: string;
  readonly port: number;
  readonly binaries: PostgresBinaries;
  readonly label: string;
}): Promise<LocalHaServer> {
  mkdirSync(options.dataDir, { recursive: true });
  const init = spawnSync(options.binaries.initdb, [
    "-D",
    options.dataDir,
    "-U",
    "postgres",
    "--auth=trust",
    "-E",
    "UTF8",
  ]);
  if (init.error !== undefined || init.status !== 0) {
    throw new LocalHaTopologyError(
      `initdb failed for the ${options.label} server: ${init.error?.message ?? init.stderr}`,
    );
  }
  appendFileSync(
    `${options.dataDir}/postgresql.conf`,
    [
      "",
      "# Zeck HA drill (disposable topology — WORK-057)",
      `port = ${options.port}`,
      "listen_addresses = '127.0.0.1'",
      "unix_socket_directories = ''",
      "wal_level = replica",
      "max_wal_senders = 10",
      "wal_keep_size = 256MB",
      "hot_standby = on",
      "max_connections = 40",
      "",
    ].join("\n"),
  );
  return spawnPostgresServer(options);
}

/**
 * Bootstrap a REAL standby from a running local primary: the manual
 * base-backup procedure (backup start → copy → backup stop → label +
 * standby.signal + primary_conninfo → start → wait for streaming).
 * The primary keeps serving throughout (it is read for the copy in
 * backup mode — the same WAL guarantees the D-07 backup engine uses).
 */
export async function bootstrapStandbyFromPrimary(options: {
  readonly primary: LocalHaServer;
  readonly standbyDataDir: string;
  readonly standbyPort: number;
  readonly binaries: PostgresBinaries;
  readonly applicationName: string;
  readonly streamingTimeoutMs?: number;
}): Promise<LocalHaServer> {
  const client = new Client({ connectionString: options.primary.adminUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_backup_start($1, true)", ["zeck-ha-drill-standby"]);
    rmSync(options.standbyDataDir, { recursive: true, force: true });
    cpSync(options.primary.dataDir, options.standbyDataDir, { recursive: true });
    // A standby's data directory is the COPY: drop the live server's
    // lock file and volatile runtime state, keep everything else.
    rmSync(`${options.standbyDataDir}/postmaster.pid`, { force: true });
    for (const dir of VOLATILE_SUBDIRS) {
      rmSync(`${options.standbyDataDir}/${dir}`, { recursive: true, force: true });
      mkdirSync(`${options.standbyDataDir}/${dir}`, { recursive: true });
    }
    chmodSync(options.standbyDataDir, 0o700);
    const stopped = await client.query<{ labelfile: string; spcmapfile: string }>(
      "SELECT labelfile, spcmapfile FROM pg_backup_stop()",
    );
    const label = stopped.rows[0]?.labelfile;
    const spaceMap = stopped.rows[0]?.spcmapfile;
    if (label === undefined || spaceMap === undefined) {
      throw new LocalHaTopologyError("pg_backup_stop returned no backup label (bootstrap defect)");
    }
    writeFileSync(`${options.standbyDataDir}/backup_label`, label);
    writeFileSync(`${options.standbyDataDir}/tablespace_map`, spaceMap);
    writeFileSync(`${options.standbyDataDir}/standby.signal`, "");
    appendFileSync(
      `${options.standbyDataDir}/postgresql.conf`,
      [
        "",
        "# Zeck HA drill standby (WORK-057)",
        `port = ${options.standbyPort}`,
        "listen_addresses = '127.0.0.1'",
        "unix_socket_directories = ''",
        "hot_standby = on",
        `primary_conninfo = 'host=127.0.0.1 port=${options.primary.port} user=postgres application_name=${options.applicationName}'`,
        "wal_keep_size = 256MB",
        "max_connections = 40",
        "",
      ].join("\n"),
    );
  } finally {
    await client.end().catch(() => undefined);
  }
  // The standby's data directory IS the base backup — no initdb; the
  // copied postgres process starts straight into streaming recovery.
  const standby = await spawnPostgresServer({
    dataDir: options.standbyDataDir,
    port: options.standbyPort,
    binaries: options.binaries,
    label: "standby",
  });
  // Wait until the walreceiver reports streaming to the primary.
  const timeoutMs = options.streamingTimeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probeClient = new Client({ connectionString: options.primary.adminUrl });
    try {
      await probeClient.connect();
      const state = await probeClient.query<{ readonly state: string }>(
        "SELECT state FROM pg_stat_replication WHERE application_name = $1",
        [options.applicationName],
      );
      await probeClient.end();
      if (state.rows[0]?.state === "streaming") {
        return standby;
      }
    } catch (error) {
      try {
        await probeClient.end();
      } catch {
        // Connection raced with teardown.
      }
      if (Date.now() >= deadline) {
        await standby.terminate("stop").catch(() => undefined);
        throw new LocalHaTopologyError(
          `the standby did not attach to the primary within ${timeoutMs}ms: ${redactConnectionString((error as Error).message)}`,
        );
      }
    }
    if (Date.now() >= deadline) {
      await standby.terminate("stop").catch(() => undefined);
      throw new LocalHaTopologyError(
        `the standby did not reach streaming replication within ${timeoutMs}ms (see ${standby.logsPath})`,
      );
    }
    await sleep(250);
  }
}

/** Bounded catch-up gate over the platform probe (readiness evidence). */
export async function waitForStandbyCatchup(
  primaryUrl: string,
  applicationName: string,
  timeoutMs: number,
): Promise<{ readonly bytesBehind: number; readonly waitedMs: number }> {
  const probe = new PgReplicationProbe();
  return probe.waitForStandbyCatchup(primaryUrl, applicationName, { timeoutMs });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
