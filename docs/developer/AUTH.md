# Authentication and application setup

**One sentence:** every request authenticates with a bearer **Zeck
transport credential**, every scoped operation names an **application**
whose durable membership rows authorize it (server-side derived), and no
provider credential ever appears client-side.

## The three connection values

| Variable | What it is | What it is NOT |
|---|---|---|
| `ZECK_API_URL` | The base URL of the target deployment's public API. | Not a provider endpoint. |
| `ZECK_TOKEN` | A **Zeck** transport credential (bearer). | NOT a provider API key — there is no field, header or example where a provider key could even appear client-side. |
| `ZECK_APPLICATION_ID` | The application whose scope authorizes scoped reads and governed commands. | Not a tenant id — the tenant is derived server-side. |

Machine-readable contract: [machine/env-vars.json](machine/env-vars.json).
The loader every example uses: `examples/lib/env.ts`.

## Where the values come from

1. **A deployed environment** — the platform's credential/console
   surfaces issue application-scoped credentials per environment. The
   promotion ladder (`local → preview → staging → production`) and the
   operator-side secret model are documented in
   [PRODUCTION.md](PRODUCTION.md) and owned by `deploy/` (DEP-001).
2. **A local composition** — a locally composed control plane exposes
   the same public API (the default base URL `http://127.0.0.1:3000`
   matches the CLI's default).

> The developer console surfaces (application creation UI, API-key UX)
> are a separate delivery (DEP-010/DEP-011). This page documents the
> contract those surfaces expose — the wire rules are frozen here
> either way.

## The auth model on the wire

```text
Authorization: Bearer <ZECK_TOKEN>              (every request)
X-Zeck-Application: <ZECK_APPLICATION_ID>       (every scoped read/command)
Idempotency-Key: <your-stable-key>              (every POST)
```

- **Authentication** → a `Principal` (an authenticated actor
  reference). Missing/invalid credentials → `401 AUTHENTICATION_FAILED`
  (never retryable).
- **Scope derivation** → the `X-Zeck-Application` header NAMES the
  application; the effective tenant/application scope is derived
  SERVER-SIDE from durable membership rows. The header never authorizes
  anything by itself, and a scoped request without it is rejected.
- **The split contract** (worth internalizing): *creation* carries the
  application selector in the request body's `applicationId`; every
  *scoped read and governed command* carries it in the
  `X-Zeck-Application` header. The SDK handles this split for you.

## The request identity flow

```text
bearer credential → Principal
X-Zeck-Application → durable membership rows → {tenant, application} scope
scope + request → policy admission → …
```

Cross-tenant access is unrepresentable in practice: every read resolves
the row first, scope-checked through the authority's application-scoped
getters — another application's resource is a 404 indistinguishable
from a missing one (`TENANT_SCOPE_VIOLATION` only surfaces as the
explicit tenant guard).

## The SDK client

```typescript
import { createZeckClient } from "../sdk";

const client = createZeckClient({
  baseUrl: process.env.ZECK_API_URL!,
  token: process.env.ZECK_TOKEN!,            // a Zeck credential — never a provider key
  applicationId: process.env.ZECK_APPLICATION_ID!,
});
```

- Scoped methods send `X-Zeck-Application` automatically.
- A scoped method on a client constructed *without* an application
  scope fails fast **client-side** — the wire contract is pinned, never
  discovered.
- Provider-selection attempts are rejected client-side before any
  request is issued.

## Credentials discipline (the rules the battery enforces)

1. Credentials live in the environment — never command-line flags
   (shell history is a leak surface), never committed files.
2. `ZECK_TOKEN` is a Zeck transport credential. Provider connections
   are **BYOK references** held server-side by the platform
   ([CONFIGURATION.md](CONFIGURATION.md)).
3. Webhook **signing** secrets are receiver-side material
   (`ZECK_WEBHOOK_SECRET` in the receiver example) — out-of-band, never
   in a URL, never logged.
4. No example, doc or machine artifact in this kit contains a
   credential-shaped value (secret scan in the battery).

## Application and environment setup

- **Application** — the durable scope of your integrations: executions,
  agent inventory, economic actions and analyses are all
  application-scoped.
- **Environment** — an optional execution selector (`environmentId` on
  create, e.g. a disposable sandbox environment). Environments are
  governed platform-side: class (disposable/persistent), data policy,
  credential scope (see [SANDBOX.md](SANDBOX.md) and
  `deploy/manifests/environments.json`).
- **End-user attribution** — pass `userId` on create to attribute the
  execution (and any spend) to your end user.

## Failure modes you will actually see

| Symptom | Code | Cause | Remedy |
|---|---|---|---|
| `401` on every call | `AUTHENTICATION_FAILED` | Missing/malformed/unknown credential | Fix `ZECK_TOKEN`; check the bearer scheme |
| `401` only on scoped reads | `AUTHENTICATION_FAILED` | Client built without scope + hand-rolled fetch | Build the client with `applicationId` |
| `403` cross-tenant | `TENANT_SCOPE_VIOLATION` | Header names an application whose tenant differs | Use the owning application's scope |
| `403` policy | `POLICY_DENIED` | A published restriction denies the operation | Inspect the governing policy documents |

Full taxonomy: [machine/error-codes.json](machine/error-codes.json) and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
