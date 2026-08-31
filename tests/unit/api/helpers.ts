/** A minimal FastifyReply fake for error-mapper tests (no server). */

export interface FastifyReplyLike {
  readonly statusCode: number;
  readonly sentBody: unknown;
}

export function fakeReply(): FastifyReplyLike & {
  status(code: number): { send(body: unknown): FastifyReplyLike };
  readonly log: { error(...args: unknown[]): void };
} {
  const state: { statusCode: number; sentBody: unknown } = { statusCode: 0, sentBody: null };
  const reply = {
    get statusCode() {
      return state.statusCode;
    },
    get sentBody() {
      return state.sentBody;
    },
    status(code: number) {
      state.statusCode = code;
      return {
        send(body: unknown) {
          state.sentBody = body;
          return reply as never;
        },
      };
    },
    log: {
      error() {
        // server-side logging only — never serialized
      },
    },
  };
  return reply as never;
}
