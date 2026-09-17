# Going to production — promotion, secrets, quotas, migration and rollback

**One sentence:** the production path is the repository-defined
promotion ladder (`local → ci → preview → staging → production`) with
environment-scoped secrets, quota guards and release gates — owned by
the deployment surfaces (`deploy/`, DEP-001) which this page
cross-links, never duplicates. To run a Zeck deployment yourself (the
developer-side entry into the same foundation), start from
[SELF-HOSTING.md](SELF-HOSTING.md).

## Your integration changes NOTHING between sandbox and production

The single most important fact: the wire contract is identical across
environments. Moving to production means pointing `ZECK_API_URL` at
the production API with production-scoped credentials — your code, the
SDK usage, the task shapes and the error handling do not change.
Provider neutrality means there is also no "production model id" to
hardcode (you could not if you tried — the create contract rejects it).

```bash
export ZECK_API_URL="https://api.your-zeck-production.example"
export ZECK_TOKEN="<production-scoped-zeck-credential>"
export ZECK_APPLICATION_ID="<production-application-id>"
```

## The promotion ladder (repository truth)

From `deploy/manifests/environments.json` (owned by DEP-001 — the
authoritative matrix):

| Phase | Class | Data policy | Teardown | Promotion requires |
|---|---|---|---|---|
| `local` | disposable | synthetic-only | allowed | governance-check, typecheck, lint, full test suite |
| `ci` | check phase (not a hosting class) | — | — | the gates themselves |
| `preview` | disposable (per-branch) | synthetic-only | allowed | ci-gates, preview-smoke |
| `staging` | persistent | staging-only | refused | architect-approval, staging-smoke, deployment-identity-audit |
| `production` | persistent | authoritative | refused | — (terminal) |

Preview resources are never implicitly promoted; staging exists to
prove production behavior BEFORE promotion.

## Secret management (the model, cross-linked)

- **Client side** (your integration): credentials live in the
  environment only — `ZECK_TOKEN` is a Zeck credential; provider keys
  NEVER appear client-side ([AUTH.md](AUTH.md),
  [machine/env-vars.json](machine/env-vars.json)).
- **Platform side** (operator): infrastructure credentials enter
  exclusively as `zeck-secret://<environment>/…` references
  (`deploy/manifests/secret-references.json`); the reference is
  non-secret, the materialized value never is; manifests are
  secret-scanned (`deploy/lib.ts`, `scanManifestsForSecretPlaintext`).
- **Webhook secrets**: receiver-side material, delivered out-of-band
  ([WEBHOOKS.md](WEBHOOKS.md)).

## Quotas and guardrails

The quota/operational alert thresholds are repository truth
(`deploy/manifests/quota-guards.json`, DEP-001/D-06): actionable,
fail-closed thresholds with the closed gate-kind vocabulary in
`deploy/manifests/release-policy.json`. As an integrator you
experience quota behavior as honest errors (`BUDGET_EXCEEDED` 402;
provider quota boundaries recorded as availability facts — see
[AVAILABILITY.md](AVAILABILITY.md)).

## Release control, migration and rollback (operator surfaces)

Cross-linked, owned by the deployment delivery (D-06, `deploy/release.ts`
+ `deploy/migrate.ts`):

- **Release gates** — per-phase entry gates (record/gate/promote/
  rollback/inspect/status/alerts operator surface).
- **Migration** — deterministic managed-PostgreSQL startup/migrations
  (`deploy/migrate.ts`; the migration runner is exercised in the
  integration suites).
- **Rollback** — the release-control rollback path with
  backup/restore drills (`deploy/backup.ts`, `deploy/restore.ts` — the
  executed restore drill is part of the deployment evidence).
- **Deployment identity** — exact-revision attestation
  (`deploy/identity.ts`, `deploy/smoke.ts`): readiness + the exact Git
  revision of what is deployed.

## The developer-platform production doctrine

Free-tier-first provider selection with provider-neutral ports and a
clean upgrade/exit path (see the roadmap's doctrine section,
`docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md`): disposable free-tier
resources must never become operationally critical; commercial
production requires commercially permitted plans (e.g. Vercel Hobby is
restricted to permitted personal/non-commercial use — commercial
production needs a permitted plan or a replacement host).

## The production readiness checklist (integrator side)

1. Credentials: environment-only, production-scoped, never in code or
   flags; rotate through the credential surface.
2. Idempotency: every create carries YOUR stable key; your retry
   policy retries only retryable failures (`examples/error-handling.ts`).
3. Webhooks: signature verification + durable dedupe on `eventId`
   (`examples/webhook-receiver.ts`); polling as the fallback of record.
4. Budgets: per-run `maxCostMicroUsd` always set; aggregate budgets
   agreed with the operator.
5. Evidence: your pipeline retains result packages + event ledgers +
   verification results (the audit trail).
6. Terminal-state handling: every terminal status is handled
   (`COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`) — see
   [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
7. Availability: your workload families' rails exist in the production
   environment's allowlist ([AVAILABILITY.md](AVAILABILITY.md)).

## Cross-reference map (the deployment surfaces this page links to)

| Artifact | Owner | Content |
|---|---|---|
| `deploy/README.md` | DEP-001 | The deployment foundation: manifests, tools, executed drills |
| `deploy/manifests/environments.json` | DEP-001 | The environment matrix + promotion ladder (repository truth) |
| `deploy/manifests/secret-references.json` | DEP-001 | The environment-scoped secret-reference inventory |
| `deploy/manifests/variables.json` | DEP-001 | The operator-side environment variable contract |
| `deploy/manifests/quota-guards.json` | DEP-001/D-06 | Quota/operational alert thresholds |
| `deploy/manifests/release-policy.json` | DEP-001/D-06 | The closed gate-kind vocabulary + per-phase entry gates |
| `docs/DEPLOYMENT-ARCHITECTURE.md` | Architect | D1.0 — the authoritative deployment and runtime architecture |
| `docs/DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md` | Architect | The developer-platform program (sandbox + free-tier doctrine) |

Public contract links: your integration surface is unchanged —
`sdk/index.ts`, `src/shared/wire.ts`,
[machine/openapi.json](machine/openapi.json).
