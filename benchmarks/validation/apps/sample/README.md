# Sample application — customer-style Zeck integration (VAL-002)

The minimal customer application skeleton. It integrates with Zeck
EXACTLY the way an external developer would: the public `sdk/` client
over the real HTTP API, configuration from repository files plus ONE
environment secret, public submission/completion/retrieval modes,
deterministic assertions and evidence emission.

## What it proves

- a minimal application can invoke Zeck through the supported customer
  integration boundary (nothing internal is imported — the import
  scanner test proves it mechanically);
- the harness supports submission, asynchronous completion, result
  retrieval and error reporting through the public modes;
- the run carries a stable identity and records application + Zeck
  revisions;
- the emitted evidence satisfies the recorder consumption contract.

## Configuration

`config.json` is repository-reproducible and secret-free. The transport
credential is referenced by NAME (`tokenEnvVar: ZECK_VALIDATION_TOKEN`)
and resolved from the environment at run time — a secret can never
appear in the file (the config validator rejects secret-shaped values).

`applicationId`, `baseUrl` and the revision fields are bound at run
time by the executing context (the served API world); the repository
file documents the shape.

## Running it

The application is executed by the validation suites:

```bash
# unit-level (fake transport, deterministic):
bunx vitest run tests/unit/validation

# end-to-end against a real served API + real PostgreSQL:
ZECK_PG_TEST_URL=postgres://user@127.0.0.1:5432/postgres \
  bunx vitest run tests/integration/validation
```

The integration suite boots the REAL public API server (Fastify) over
the REAL SQL authorities on a local port and runs this application
through a real transport — the exact public path a customer rides.

## Clean checkout

From a fresh clone of this repository:

```bash
bun install
ZECK_PG_TEST_URL=... bunx vitest run tests/integration/validation
```

No internal source imports are needed or used — the application rides
`sdk/` and `benchmarks/validation/harness` only.
