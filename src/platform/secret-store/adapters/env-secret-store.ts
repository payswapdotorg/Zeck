/**
 * Environment-materialization secret store adapter (WORK-043 / D-02).
 *
 * The secret-reference model (D1.0 §14, `IMPLEMENTATION.md` §9):
 * credentials are opaque `zeck-secret://<environment>/<name>`
 * references; the VALUES are materialized externally by the operator
 * or the provisioning plane. This adapter is the read side of that
 * materialization for process environments: the value of the secret
 * `<name>` in environment `<environment>` is read from a
 * deterministic, credential-shaped environment variable, immediately
 * before the authorized adapter call — never stored, never logged,
 * never echoed (fail-closed error messages carry the VARIABLE NAME
 * and the reference URI only; both are non-secret by construction).
 *
 * The materialization map is repository-owned: every secret the
 * D-02 runtime path needs (database URL, R2 access key id, R2 secret
 * access key) maps to one documented `ZECK_*` variable in
 * `deploy/manifests/variables.json` (credentialShaped: true —
 * environment-only storage, never committed).
 *
 * `store()` is fail-closed by design: writing secrets into the
 * process environment is not a platform capability — external
 * materialization is performed by the operator/provisioning plane.
 */
import type {
  ResolvedSecret,
  SecretClassification,
  SecretReference,
  SecretStorePort,
  StoreSecretRequest,
} from "../port";

const REFERENCE_URI_PATTERN = /^zeck-secret:\/\/([a-z]+)\/([a-z0-9-]+)$/;

/** Materialized-value variable for one secret name (credential-shaped). */
export const DEFAULT_MATERIALIZATION: Readonly<Record<string, string>> = Object.freeze({
  "database-url": "ZECK_DATABASE_URL",
  "object-store-access-key-id": "ZECK_OBJECT_STORE_ACCESS_KEY_ID",
  "object-store-secret-access-key": "ZECK_OBJECT_STORE_SECRET_ACCESS_KEY",
  "queue-api-token": "ZECK_QUEUE_API_TOKEN",
  "workflow-api-token": "ZECK_WORKFLOW_API_TOKEN",
  "container-runner-token": "ZECK_CONTAINER_RUNNER_API_TOKEN",
  "otlp-auth-token": "ZECK_OTLP_AUTH_TOKEN",
});

/** The classification map for the D-02..D-06 secret inventory. */
export const DEFAULT_CLASSIFICATIONS: Readonly<Record<string, SecretClassification>> =
  Object.freeze({
    "database-url": "provider-credential",
    "object-store-access-key-id": "provider-credential",
    "object-store-secret-access-key": "provider-credential",
    "queue-api-token": "provider-credential",
    "workflow-api-token": "provider-credential",
    "container-runner-token": "provider-credential",
    "otlp-auth-token": "provider-credential",
  });

export interface EnvSecretStoreDeps {
  /** The environment identity this process represents (`ZECK_ENVIRONMENT`). */
  readonly environment: string;
  /** Read-only view of the process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Override the materialization map (tests only). */
  readonly materialization?: Readonly<Record<string, string>>;
  /** Override the classification map (tests only). */
  readonly classifications?: Readonly<Record<string, SecretClassification>>;
}

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

/** Validate the `zeck-secret://<environment>/<name>` reference shape. */
export function parseSecretReference(reference: string): {
  readonly environment: string;
  readonly name: string;
} {
  const match = REFERENCE_URI_PATTERN.exec(reference);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new SecretResolutionError(
      "a secret reference must have the form zeck-secret://<environment>/<name>",
    );
  }
  return { environment: match[1], name: match[2] };
}

/**
 * Validate a reference string and return the branded opaque
 * `SecretReference` handle (the only sanctioned way to construct one
 * at an adapter boundary — the URI shape is verified first).
 */
export function asSecretReference(reference: string): SecretReference {
  parseSecretReference(reference);
  return reference as SecretReference;
}

/**
 * The environment-materialization `SecretStorePort`: resolves
 * environment-scoped references to their externally materialized
 * values. Cross-environment resolution is rejected (production
 * material is not addressable from a non-production process); absent
 * materialization fails closed with the variable NAME (never a
 * value).
 */
export function createEnvSecretStore(deps: EnvSecretStoreDeps): SecretStorePort {
  const materialization = deps.materialization ?? DEFAULT_MATERIALIZATION;
  const classifications = deps.classifications ?? DEFAULT_CLASSIFICATIONS;
  return {
    async resolve(reference: string): Promise<ResolvedSecret> {
      const { environment, name } = parseSecretReference(reference);
      if (environment !== deps.environment) {
        throw new SecretResolutionError(
          `cannot resolve ${environment}-scoped reference from a ${deps.environment} process (environment isolation)`,
        );
      }
      const variable = materialization[name];
      if (variable === undefined) {
        throw new SecretResolutionError(
          `secret "${name}" has no materialization variable in the repository contract`,
        );
      }
      const value = deps.env[variable];
      if (value === undefined || value.length === 0) {
        throw new SecretResolutionError(
          `the materialized value of zeck-secret://${environment}/${name} is absent: ${variable} is not set`,
        );
      }
      const classification = classifications[name];
      if (classification === undefined) {
        throw new SecretResolutionError(
          `secret "${name}" has no classification in the repository contract`,
        );
      }
      return {
        reference: reference as SecretReference,
        classification,
        plaintext: value,
      };
    },
    async store(_request: StoreSecretRequest): Promise<SecretReference> {
      void _request;
      throw new SecretResolutionError(
        "the environment materialization is read-only: secrets are stored by the external provisioning plane, never written by the platform",
      );
    },
  };
}
