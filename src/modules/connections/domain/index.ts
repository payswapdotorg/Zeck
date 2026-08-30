/**
 * `connections` domain layer — entities, invariants and value objects of this module.

Domain code may import this module's own layers, `src/shared/**` and other
modules' `public.ts` — never `src/platform/**`, adapters, provider SDKs or
HTTP libraries (`IMPLEMENTATION.md` §3).
 */
export type {
  ConnectionDispatchFacts,
  ConnectionRecord,
  ConnectionStatus,
  CredentialKind,
  RegisteredCredential,
} from "./connection";
export { CONNECTION_STATUSES } from "./connection";
export {
  isProviderRail,
  isValidConnectionLabel,
  isValidEndpointUrl,
  PROVIDER_RAILS,
  type RailSlug,
} from "./rails";
