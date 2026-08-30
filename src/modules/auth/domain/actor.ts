/**
 * Actor identity contracts (auth module domain).
 *
 * An actor is the durable identity record. How a caller proves actorship
 * (credential transport, tokens, keys) is owned by later Work Orders; the
 * `Principal` contract here is what authenticated transport hands to the
 * application layer — an already-authenticated actor reference.
 */

/** Durable actor record. */
export interface Actor {
  readonly id: string;
  /** Federated/external subject identifier, when the actor arrived via an external identity rail. */
  readonly externalSubject: string | null;
  readonly displayName: string;
  readonly createdAt: string;
}

/**
 * An authenticated actor reference produced by the transport authentication
 * step. Application layers never authenticate; they consume principals.
 */
export interface Principal {
  readonly actorId: string;
  readonly authenticatedAt: string;
}

/** Provision a new actor (idempotent at the store layer). */
export interface ProvisionActorInput {
  readonly displayName: string;
  readonly externalSubject?: string;
}
