/**
 * Provider-neutral relational database port (PostgreSQL 16+ authority).
 *
 * The adapter arrives with the Work Order that owns the first durable state;
 * until then this contract is the only database surface of the platform.
 * Domain modules never import this port directly — they depend on their own
 * module ports and module adapters bridge to the platform
 * (`IMPLEMENTATION.md` §3). Durable authority boundaries remain transactional
 * and idempotent per `spec/contracts.md`.
 */
export interface DatabasePort {
  /**
   * Run `work` inside a transaction. The adapter guarantees atomic commit or
   * rollback; retry-safe idempotency is owned by the calling authority, not
   * by this port.
   */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;

  execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>>;
}

export interface Transaction {
  execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>>;
}

export interface Query {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
}

export interface QueryResult<T> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}
