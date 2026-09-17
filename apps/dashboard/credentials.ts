/**
 * Zeck credentials console module (DEP-011 — the credential lifecycle
 * projection layer over the public API).
 *
 * A PROJECTION, NEVER A SECOND CREDENTIAL AUTHORITY (DEP-011): this module
 * holds NO console-local credential state. Every credential fact rendered
 * comes from the credential AUTHORITY through the public API routes
 * (`src/api/routes/credentials.ts`), read through the module-local
 * transport below — the same discipline as the Validation Lab's projection
 * of the validation corpus. The console composes; it never stores secrets,
 * never derives scopes and never re-implements lifecycle rules.
 *
 * THE SHOW-ONCE CONTRACT ON THE CONSOLE SIDE: the issue/rotate reveal is
 * the RESPONSE to the governed POST itself (there is no server-side session
 * state — M24), so a page refresh re-POSTs the same idempotency key and
 * the honest REPLAY page renders (the authority returns the record with
 * NO secret — "rotate to obtain a new one"). The secret is rendered in the
 * reveal response exactly once; no later GET can retrieve it because no
 * route can.
 *
 * THE TRANSPORT: the SDK client's surface is frozen (`sdk/**` is the public
 * contract; adding the credential client methods is the Lead's merge note),
 * so this module carries its own minimal fetch transport for the four
 * public credential routes — Bearer authorization, the canonical
 * X-Zeck-Application scope selector and Idempotency-Key headers, exactly
 * the wire contract the routes enforce. The transport is injectable through
 * the pages composition seam (`DashboardRoutesOptions.credentials`); when
 * absent it is derived from the deployment's environment contract
 * (ZECK_API_URL / ZECK_TOKEN / ZECK_APPLICATION_ID — the same variables the
 * dashboard's entry point requires), and when those are not bound the
 * console renders the honest unavailable state naming the missing wiring.
 *
 * SECRETS SAFETY: every interpolated value passes through `esc`; the
 * hostile-value probes pin that neither the transport token nor any
 * secret-shaped value renders on any page except the show-once reveal of
 * the secret the authority just returned.
 */

import { PROVIDER_ACCESS } from "../../benchmarks/validation/capabilities";
import { type PublicError, ZeckApiError } from "../../sdk";
import { distinctionList, esc, keyValueTable, statusBadge } from "./components";
import { pageHead } from "./shell";
import { emptyState, errorState, unavailableState } from "./states";

// ---------------------------------------------------------------------------
// The public-API shapes this projection consumes (mirrored locally — the
// frozen shared wire contract is NOT extended by the console)
// ---------------------------------------------------------------------------

export interface ConsoleCredentialRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly applicationId: string;
  readonly label: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly supersededBy: string | null;
  readonly permissions: readonly string[];
}

export interface CredentialListView {
  readonly credentials: readonly ConsoleCredentialRecord[];
  readonly issuance: { readonly enabled: boolean };
}

export interface CredentialIssueView {
  readonly credential: ConsoleCredentialRecord;
  readonly secret: string | null;
  readonly replayed: boolean;
}

export interface CredentialRevokeView {
  readonly credential: ConsoleCredentialRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// The transport (module-local; the frozen SDK client gains nothing here)
// ---------------------------------------------------------------------------

export interface CredentialConsoleTransport {
  listCredentials(): Promise<CredentialListView>;
  issueCredential(
    input: { readonly label: string; readonly role: string },
    idempotencyKey: string,
  ): Promise<CredentialIssueView>;
  rotateCredential(credentialId: string, idempotencyKey: string): Promise<CredentialIssueView>;
  revokeCredential(credentialId: string, idempotencyKey: string): Promise<CredentialRevokeView>;
}

export interface CredentialTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly applicationId: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Create the credential console transport over the public credential routes.
 * Every call carries the house headers: Bearer authorization (the Zeck
 * transport credential — never a provider key), the X-Zeck-Application
 * scope selector and (on POSTs) the mandatory Idempotency-Key.
 */
export function createCredentialConsoleTransport(
  options: CredentialTransportOptions,
): CredentialConsoleTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    idempotencyKey?: string,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      "x-zeck-application": options.applicationId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    };
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let parsed: PublicError | null = null;
      try {
        parsed = (await response.json()) as PublicError;
      } catch {
        parsed = null;
      }
      throw new ZeckApiError(
        response.status,
        parsed ?? {
          code: "PROVIDER_ERROR",
          message: `unexpected transport failure (HTTP ${response.status})`,
          retryable: response.status >= 500,
        },
      );
    }
    return (await response.json()) as T;
  };
  return {
    async listCredentials() {
      return request<CredentialListView>("GET", "/credentials", undefined);
    },
    async issueCredential(input, idempotencyKey) {
      return request<CredentialIssueView>(
        "POST",
        "/credentials",
        {
          applicationId: options.applicationId,
          label: input.label,
          role: input.role,
        },
        idempotencyKey,
      );
    },
    async rotateCredential(credentialId, idempotencyKey) {
      return request<CredentialIssueView>(
        "POST",
        `/credentials/${encodeURIComponent(credentialId)}/rotate`,
        {},
        idempotencyKey,
      );
    },
    async revokeCredential(credentialId, idempotencyKey) {
      return request<CredentialRevokeView>(
        "POST",
        `/credentials/${encodeURIComponent(credentialId)}/revoke`,
        {},
        idempotencyKey,
      );
    },
  };
}

/**
 * The deployment-bound transport: derived from the console's environment
 * contract (the SAME variables the dashboard entry point requires). Absent
 * bindings mean the console honestly cannot reach the credential routes —
 * null, never a fabricated transport.
 */
export function credentialTransportFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): CredentialConsoleTransport | null {
  const baseUrl = env.ZECK_API_URL;
  const token = env.ZECK_TOKEN;
  const applicationId = env.ZECK_APPLICATION_ID;
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof applicationId !== "string" ||
    applicationId.length === 0
  ) {
    return null;
  }
  return createCredentialConsoleTransport({
    baseUrl,
    token,
    applicationId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

// ---------------------------------------------------------------------------
// The issue form (closed vocabulary, client-side validation before wire)
// ---------------------------------------------------------------------------

/** The form keys the issue flow round-trips (the closed form vocabulary). */
export const CREDENTIAL_FORM_KEYS: readonly string[] = ["label", "role", "idempotencyKey"];

/** The role choices (the house vocabulary the authority accepts). */
export const CREDENTIAL_ROLE_CHOICES: readonly string[] = ["admin", "member", "owner"];

export interface CredentialIssueFormValues {
  readonly label: string;
  readonly role: string;
  readonly idempotencyKey: string;
}

export type CredentialIssueFormErrors = Record<string, string>;

/**
 * Validate the issue form against the authority's recorded contract
 * (client-side, before any wire call): the label shape, the closed role
 * vocabulary and a non-empty idempotency key.
 */
export function validateCredentialIssueForm(form: Readonly<Record<string, string>>): {
  readonly values: CredentialIssueFormValues | null;
  readonly errors: CredentialIssueFormErrors;
} {
  const errors: CredentialIssueFormErrors = {};
  const label = (form.label ?? "").trim();
  const role = (form.role ?? "").trim();
  const idempotencyKey = (form.idempotencyKey ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(label)) {
    errors.label =
      "Enter a label of 1..64 characters: starts with a letter or digit, then letters, digits, spaces, dots, underscores or hyphens (the authority's recorded shape).";
  }
  if (!(CREDENTIAL_ROLE_CHOICES as readonly string[]).includes(role)) {
    errors.role = `Choose one of the assignable roles (${CREDENTIAL_ROLE_CHOICES.join(", ")}).`;
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 256) {
    errors.idempotencyKey =
      "The form state was lost — open the credentials page again for a fresh idempotency key.";
  }
  return {
    values: Object.keys(errors).length === 0 ? { label, role, idempotencyKey } : null,
    errors,
  };
}

/** The role's permission scope, read from the record's own authority projection. */
export function permissionsLineOf(record: ConsoleCredentialRecord): string {
  return record.permissions.join(", ");
}

// ---------------------------------------------------------------------------
// Section renderers (the projection)
// ---------------------------------------------------------------------------

/**
 * The honest not-reachable state: the public credential ROUTES exist —
 * this console's deployment configuration simply does not bind the
 * transport to reach them. (The generic "not yet exposed by the public
 * API" wording would be false for this surface: the routes ship with
 * DEP-011.)
 */
function transportUnboundState(concept: string): string {
  return `<div class="state state-unavailable">
  <p class="state-title">${esc(concept)} — not reachable from this console deployment</p>
  <p class="state-body">The public credential routes exist; this console's deployment configuration does not bind the transport that reaches them. Set ZECK_API_URL, ZECK_TOKEN and ZECK_APPLICATION_ID where the console runs (the same contract its SDK client binding requires) — the console holds no credential state of its own and will not invent one.</p>
  <p class="state-source">Projected from the credential authority through the public API, once the transport is bound.</p>
</div>`;
}

const NOT_CARRIED_BOUNDARIES: readonly { readonly fact: string; readonly why: string }[] = [
  {
    fact: "Last used",
    why: "the public credential contract carries no last-used fact (no usage telemetry crosses it) — this column is not renderable from the authority",
  },
  {
    fact: "Usage and cost attribution",
    why: "the public credential contract carries no per-credential usage or cost facts — nothing here invents them",
  },
];

function credentialRow(record: ConsoleCredentialRecord): string {
  const scopeNote =
    record.status === "retired" && record.supersededBy !== null
      ? `retired by rotation — superseded by <span class="mono">${esc(record.supersededBy)}</span>`
      : record.rotatedAt !== null
        ? `rotated at ${esc(record.rotatedAt)}`
        : "never rotated";
  const actions =
    record.status === "active"
      ? `<a class="button-link" href="/console/applications/keys?rotate=${encodeURIComponent(
          record.credentialId,
        )}">Rotate…</a>
      <a class="button-link" href="/console/applications/keys?revoke=${encodeURIComponent(
        record.credentialId,
      )}">Revoke…</a>`
      : '<span class="muted">no actions — this record is terminal</span>';
  return `<tr>
      <td>${esc(record.label)}</td>
      <td class="mono">${esc(record.credentialId)}</td>
      <td>${esc(record.role)}<br><span class="muted">${esc(permissionsLineOf(record))}</span></td>
      <td>${statusBadge(record.status)}</td>
      <td class="mono">${esc(record.createdAt)}</td>
      <td>${scopeNote}</td>
      <td>${actions}</td>
    </tr>`;
}

function credentialListSection(view: CredentialListView): string {
  const rows =
    view.credentials.length === 0
      ? `<tbody><tr><td colspan="7">${emptyState(
          "No credentials are issued for this application scope",
          "The credential authority records no credential for the application this console is bound to. Issue one below — the secret is shown exactly once, at creation.",
        )}</td></tr></tbody>`
      : `<tbody>${view.credentials.map(credentialRow).join("\n")}</tbody>`;
  return `<h2>Credentials in this application</h2>
<p class="muted">Metadata only, projected live from the credential authority through the public API — identity, label, role/permission scope, timestamps and status. No secret material exists on this surface (the show-once secret crossed only at creation, on the creating response).</p>
<table class="data">
  <thead><tr><th scope="col">Label</th><th scope="col">Credential identity</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Rotation</th><th scope="col">Actions</th></tr></thead>
  ${rows}
</table>
<details class="disclosure">
  <summary>Facts the public contract does not carry</summary>
  <table class="kv"><tbody>${NOT_CARRIED_BOUNDARIES.map(
    (boundary) =>
      `<tr><th scope="row">${esc(boundary.fact)}</th><td>Not available — ${esc(boundary.why)}</td></tr>`,
  ).join("")}</tbody></table>
</details>`;
}

function credentialIssueForm(
  values: CredentialIssueFormValues,
  errors: CredentialIssueFormErrors,
): string {
  // DEP-033 (accessibility + presentation hardening): field errors use
  // the stylesheet's .field-error class (the .form-error class carried no
  // rule, so errors rendered unstyled) and each error reference is wired
  // to its CONTROL through aria-describedby — announced when focus lands
  // on the field, never orphaned.
  const errorOf = (key: string): string =>
    errors[key] === undefined
      ? ""
      : `<p class="field-error" id="${esc(key)}-error" role="alert">${esc(errors[key] ?? "")}</p>`;
  const describedBy = (key: string, hintId: string): string =>
    errors[key] === undefined
      ? ` aria-describedby="${hintId}"`
      : ` aria-describedby="${hintId} ${esc(key)}-error"`;
  return `<form method="post" action="/console/applications/keys/issue" class="flow card">
  <div class="form-field">
    <label for="credential-label">Label</label>
    <input id="credential-label" name="label" type="text" value="${esc(values.label)}" maxlength="64" required${describedBy("label", "credential-label-help")}>
    <p class="muted" id="credential-label-help">A name you will recognize in the list (the authority validates its shape).</p>
    ${errorOf("label")}
  </div>
  <div class="form-field">
    <label for="credential-role">Role scope</label>
    <select id="credential-role" name="role" required${errors.role === undefined ? "" : ' aria-describedby="role-error"'}>
      ${CREDENTIAL_ROLE_CHOICES.map(
        (role) =>
          `<option value="${esc(role)}"${values.role === role ? " selected" : ""}>${esc(role)}</option>`,
      ).join("\n      ")}
    </select>
    <p class="muted">The credential carries this role's permission set — it is scoped exactly like a membership of that role (the authority's own vocabulary).</p>
    ${errorOf("role")}
  </div>
  <input type="hidden" name="idempotencyKey" value="${esc(values.idempotencyKey)}">
  ${errorOf("idempotencyKey")}
  <div class="form-actions">
    <button type="submit" class="primary">Issue credential</button>
  </div>
  <p class="muted">The secret will be shown exactly once, on the next page. You will not see it again.</p>
</form>`;
}

function issueSection(
  view: CredentialListView | null,
  values: CredentialIssueFormValues,
  errors: CredentialIssueFormErrors,
): string {
  if (view === null) {
    return `<h2>Issue a credential</h2>
${transportUnboundState("Credential issuance")}`;
  }
  if (!view.issuance.enabled) {
    return `<h2>Issue a credential</h2>
${unavailableState(
  "Credential issuance is not enabled for this deployment",
  "The deployment's composition gates issuance off (its secret store cannot hold issued credentials — for example the environment-materialization store is read-only). The console renders this gate from the authority's own issuance fact; it never fabricates a workaround.",
  "the deployment's composition (a secret store that can hold issued credentials)",
)}`;
  }
  return `<h2>Issue a credential</h2>
<p class="muted">A guided, confirm-in-form issuance: the label and role scope above are validated against the authority's contract, then the credential is created through the governed public API with a fresh idempotency key.</p>
${credentialIssueForm(values, errors)}`;
}

function connectionsSection(): string {
  return `<h2>Connections — bring your own keys</h2>
<p>Connections are governed server-side: you bring your own provider keys, the platform mediates every credential through its secret store, and provider selection never crosses a request contract (it is a forbidden request key, rejected fail-closed). The provider rails the platform's recorded capability matrix names — with the credential each one reads, by env-var NAME only — are:</p>
<table class="data">
  <thead><tr><th scope="col">Provider rail</th><th scope="col">Credential (env var name only)</th><th scope="col">What a successful probe certifies</th></tr></thead>
  <tbody>${PROVIDER_ACCESS.map(
    (access) => `<tr>
      <td class="mono">${esc(access.provider)}</td>
      <td class="mono">${esc(access.credentialEnvVar)}</td>
      <td>${esc(access.probeSummary)}</td>
    </tr>`,
  ).join("\n")}</tbody>
</table>
${distinctionList([
  {
    label: "Zero secret values on this surface",
    fact: "Connections carry BYOK references handled by the platform's secret mediation; there is no field anywhere in the console where a plaintext provider key could appear.",
    backed: true,
  },
  {
    label: "Connection health is platform-side",
    fact: "No connection-health fact crosses the public API; the closest live record is each run's own outcome. Nothing here invents a verdict.",
    backed: true,
  },
  {
    label: "Connection inventory (per-connection records)",
    fact: "Not exposed: the public API carries no connection inventory route — the rails above are the capability matrix's provider access facts, not a registry.",
    backed: false,
  },
])}
<p class="muted">Routing facts from real runs (BYOK, secret-mediated): <a href="/assets/connections">Connections</a>. Operator-side secret references: the machine manifest's env-vars contract names the variables, never values.</p>`;
}

/** A fresh console idempotency key (the dash- house prefix). */
export function freshCredentialIdempotencyKey(): string {
  return `dash-${globalThis.crypto.randomUUID()}`;
}

/**
 * The credential facts the keys page needs from the live authority read:
 * null when the transport is unbound; the view on success; a thrown
 * ZeckApiError propagates to the honest inline error rendering.
 */
export async function readCredentialView(
  transport: CredentialConsoleTransport | null,
): Promise<CredentialListView | null> {
  if (transport === null) {
    return null;
  }
  return transport.listCredentials();
}

/**
 * The credentials sections for the keys tab (the DEP-011 surface): the
 * live list, the issue flow, the confirm-then-act rotation/revocation
 * confirmations and the safe-connection facts. Every fact is projected
 * from the public API; every absence is named.
 */
export async function credentialsSections(
  transport: CredentialConsoleTransport | null,
  form: Readonly<Record<string, string>>,
  query: URLSearchParams,
  errors: CredentialIssueFormErrors = {},
): Promise<string> {
  let view: CredentialListView | null = null;
  let listSection: string;
  if (transport === null) {
    listSection = transportUnboundState("Credential listing");
  } else {
    try {
      view = await transport.listCredentials();
      listSection = credentialListSection(view);
    } catch (error) {
      const detail =
        error instanceof ZeckApiError
          ? `${error.body.code} — ${error.body.message}`
          : "the live read through the governed API failed; no further detail is exposed";
      listSection = errorState(
        "The credential list could not be read",
        "Every credential fact on this page is a live read through the public API; there is no cached fallback.",
        detail,
      );
    }
  }

  const confirmRotate = query.get("rotate");
  const confirmRevoke = query.get("revoke");
  let confirmSection = "";
  if (view !== null && confirmRotate !== null && confirmRotate.length > 0) {
    const record = view.credentials.find((row) => row.credentialId === confirmRotate);
    confirmSection =
      record === undefined
        ? errorState(
            "No such credential identity in this application scope",
            "The rotate confirmation asked for a credential the authority's list does not carry.",
          )
        : rotationConfirmCard(record);
  }
  if (view !== null && confirmRevoke !== null && confirmRevoke.length > 0) {
    const record = view.credentials.find((row) => row.credentialId === confirmRevoke);
    confirmSection =
      record === undefined
        ? errorState(
            "No such credential identity in this application scope",
            "The revoke confirmation asked for a credential the authority's list does not carry.",
          )
        : revocationConfirmCard(record);
  }

  const values: CredentialIssueFormValues = {
    label: form.label ?? "",
    role: form.role ?? "member",
    idempotencyKey: form.idempotencyKey ?? freshCredentialIdempotencyKey(),
  };

  return `${listSection}
${confirmSection}
${issueSection(view, values, errors)}
${connectionsSection()}`;
}

function rotationConfirmCard(record: ConsoleCredentialRecord): string {
  return `<section class="confirmation" aria-labelledby="rotate-confirm-title">
  <h2 class="confirmation-title" id="rotate-confirm-title">Rotate “${esc(record.label)}”?</h2>
  <p class="confirmation-warning">Consequential action — review the consequence before committing.</p>
  <table class="kv"><tbody>
    <tr><th scope="row">What will happen</th><td>A successor secret is issued for credential identity <span class="mono">${esc(record.credentialId)}</span> and shown exactly once; the current secret stops being the active record.</td></tr>
    <tr><th scope="row">Who or what is affected</th><td>Every integration still using the current secret of “${esc(record.label)}” (${esc(record.role)} scope) — update them to the successor.</td></tr>
    <tr><th scope="row">What it costs</th><td>Nothing — a rotation is a platform operation, not a billable execution.</td></tr>
    <tr><th scope="row">Why it is allowed</th><td>Your membership carries credentials:write for this application scope.</td></tr>
    <tr><th scope="row">Can it be undone</th><td>The predecessor is retired (not destroyed): rotation lineage is visible in the list, but the predecessor secret does not become active again.</td></tr>
    <tr><th scope="row">Approval required</th><td>This confirmation — the governed POST through the public API.</td></tr>
    <tr><th scope="row">Idempotency</th><td>The POST carries a fresh Idempotency-Key; retrying the same key replays the same durable outcome (and never re-shows the secret).</td></tr>
  </tbody></table>
  <form method="post" action="/console/applications/keys/${encodeURIComponent(record.credentialId)}/rotate">
    <input type="hidden" name="idempotencyKey" value="dash-${esc(String(globalThis.crypto.randomUUID()))}">
    <div class="form-actions">
      <button type="submit" class="primary">Rotate credential</button>
      <a class="button-link" href="/console/applications/keys">Not now</a>
    </div>
  </form>
</section>`;
}

function revocationConfirmCard(record: ConsoleCredentialRecord): string {
  return `<section class="confirmation" aria-labelledby="revoke-confirm-title">
  <h2 class="confirmation-title" id="revoke-confirm-title">Revoke “${esc(record.label)}”?</h2>
  <p class="confirmation-warning">Consequential action — review the consequence before committing.</p>
  <table class="kv"><tbody>
    <tr><th scope="row">What will happen</th><td>The credential identity <span class="mono">${esc(record.credentialId)}</span> transitions to revoked, immediately — every request authenticating with its secret stops being accepted.</td></tr>
    <tr><th scope="row">Who or what is affected</th><td>Every integration using this credential (${esc(record.role)} scope). This is the terminal state.</td></tr>
    <tr><th scope="row">What it costs</th><td>Nothing — a revocation is a platform operation, not a billable execution.</td></tr>
    <tr><th scope="row">Why it is allowed</th><td>Your membership carries credentials:write for this application scope.</td></tr>
    <tr><th scope="row">Can it be undone</th><td>No — revoked is terminal. A new credential can be issued afterwards, with a new identity.</td></tr>
    <tr><th scope="row">Approval required</th><td>This confirmation — the governed POST through the public API.</td></tr>
    <tr><th scope="row">Idempotency</th><td>Revocation is immediate and idempotent: revoking again converges to the same durable outcome (no error, no double effect).</td></tr>
  </tbody></table>
  <form method="post" action="/console/applications/keys/${encodeURIComponent(record.credentialId)}/revoke">
    <input type="hidden" name="idempotencyKey" value="dash-${esc(String(globalThis.crypto.randomUUID()))}">
    <div class="form-actions">
      <button type="submit" class="primary">Revoke credential</button>
      <a class="button-link" href="/console/applications/keys">Not now</a>
    </div>
  </form>
</section>`;
}

// ---------------------------------------------------------------------------
// The reveal (the show-once page — the POST response itself)
// ---------------------------------------------------------------------------

/**
 * The show-once reveal: the secret rendered exactly once, with the copy
 * affordance (a readonly field you can select and copy — no script
 * required) and the explicit "you will not see this again" contract. This
 * is the RESPONSE to the governed POST; a refresh re-POSTs the same
 * idempotency key and renders the honest replay page instead.
 */
export function credentialRevealContent(input: {
  readonly action: "issued" | "rotated";
  readonly view: CredentialIssueView;
}): string {
  const { view } = input;
  const verb = input.action === "issued" ? "issued" : "rotated";
  const recordLine = keyValueTable([
    ["Label", view.credential.label],
    ["Credential identity", view.credential.credentialId],
    ["Role scope", view.credential.role],
    ["Permission scope", permissionsLineOf(view.credential)],
    ["Status", view.credential.status],
    ["Created", view.credential.createdAt],
  ]);
  return `${pageHead({
    title: `Credential ${verb} — the secret, shown once`,
    path: "/console/applications/keys",
  })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The credential was ${verb}. The secret below is shown exactly once.</div>
<section class="reveal" aria-labelledby="reveal-title">
  <h2 id="reveal-title">This is the only time this secret is shown</h2>
  <p><strong>You will not see it again.</strong> It is not stored by the console, it is not retrievable through any route, and it cannot be re-displayed — if you lose it, rotate the credential to obtain a successor secret.</p>
  <div class="secret-reveal">
    <label for="credential-secret" class="visually-hidden">The new secret (select and copy)</label>
    <input id="credential-secret" class="mono" type="text" readonly value="${esc(view.secret ?? "")}" aria-describedby="secret-help">
    <p class="muted" id="secret-help">Click into the field, select all (Ctrl/Cmd+A), and copy (Ctrl/Cmd+C) — no script required.</p>
  </div>
  <p class="muted">Use it as the Bearer credential against the governed API (Authorization: Bearer …). Never in a URL, never in shell history, never committed.</p>
</section>
<h2>The credential record (metadata only)</h2>
${recordLine}
<p><a class="button-link" href="/console/applications/keys">Back to credentials</a></p>`;
}

/**
 * The honest replay page: the same idempotency key was re-POSTed (a page
 * refresh), so the authority returned the durable outcome WITHOUT the
 * secret. The page states exactly that — never a fabricated secret.
 */
export function credentialReplayContent(input: {
  readonly action: "issued" | "rotated";
  readonly view: CredentialIssueView;
}): string {
  const { view } = input;
  const verb = input.action === "issued" ? "issuance" : "rotation";
  return `${pageHead({
    title: `Credential ${verb} — replayed outcome`,
    path: "/console/applications/keys",
  })}
<div id="form-status" role="status" aria-live="polite" class="live-region">This was a replay of the same idempotent request — the secret is not shown again.</div>
${errorState(
  "The secret was shown only at the original creation",
  `This request replayed the durable outcome of the ${verb} (the same Idempotency-Key — most likely a page refresh). The idempotency ledger's durable outcome never contains secret material, so no replay can re-display it. If the secret was lost, rotate the credential to obtain a successor.`,
  "the show-once contract (DEP-011): the secret crossed the wire exactly once — on the original response",
)}
<h2>The credential record (metadata only)</h2>
${keyValueTable([
  ["Label", view.credential.label],
  ["Credential identity", view.credential.credentialId],
  ["Role scope", view.credential.role],
  ["Status", view.credential.status],
  ["Created", view.credential.createdAt],
])}
<p><a class="button-link" href="/console/applications/keys">Back to credentials</a></p>`;
}

/**
 * The unavailable rendering for the mutation handlers when the transport is
 * unbound (honest, named, never fabricated).
 */
export function credentialMutationUnavailableContent(kind: "issue" | "rotate" | "revoke"): string {
  return `${pageHead({ title: "Credential action unavailable", path: "/console/applications/keys" })}
${transportUnboundState(`Credential ${kind}`)}
<p><a class="button-link" href="/console/applications/keys">Back to credentials</a></p>`;
}
