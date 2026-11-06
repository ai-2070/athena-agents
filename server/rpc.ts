// The routes that moved to oRPC (shared/api/, server/api/), at the addresses they always had.
// server/index.ts hands each /api/ request here after its security checks; one that isn't an oRPC route comes
// back unmatched with its body unread, and the old routes take it.
import type http from 'node:http';
import { ORPCError, ValidationError } from '@orpc/server';
import type { AnyRouter } from '@orpc/server';
import { BodyLimitPlugin } from '@orpc/server/node';
import { OpenAPIHandler } from '@orpc/openapi/node';
import { apiRouter } from './api/index.ts';

/** The most a JSON body may be, here and in the old routes. */
export const JSON_LIMIT = 25 * 1024 * 1024;

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'TOO_MANY_REQUESTS' };

/** What a handler threw, as the old routes answer it: its own `status` (400–599) and message, else a 500. */
export function rpcError(e: unknown): ORPCError<string, unknown> {
  if (e instanceof ORPCError) return e;
  const status = e && typeof e === 'object' && 'status' in e && typeof e.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error(e);
  const message = (e instanceof Error && e.message) || String(e);
  return new ORPCError(CODES[status] || (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR'), { status, message, cause: e });
}

/** The words an error is answered with. A failed input check says what was wrong; schemas word theirs plainly. */
export function rpcErrorMessage(e: ORPCError<string, unknown>): string {
  if (e.cause instanceof ValidationError) return e.cause.issues[0]?.message || e.message;
  // (a body that doesn't parse: the old routes' words, not oRPC's)
  if (e.cause instanceof SyntaxError) return 'Body must be JSON';
  return e.message;
}

/** The body as the old routes read it: none is {}, and one that is there must be a JSON object (or list), not
 *  null or a bare number or string. Over the limit is refused in the old routes' words. */
function oldBody<R extends { body: () => Promise<unknown> }>(request: R): R {
  let read: Promise<unknown> | undefined;
  const body = async (): Promise<unknown> => {
    let b: unknown;
    try {
      b = await request.body();
    } catch (e) {
      if (e instanceof ORPCError && e.code === 'PAYLOAD_TOO_LARGE') throw new ORPCError('PAYLOAD_TOO_LARGE', { status: 413, message: 'Too large', cause: e });
      throw e;
    }
    if (b === undefined) return {};
    if (b === null || typeof b !== 'object') throw new ORPCError('BAD_REQUEST', { message: 'Body must be a JSON object' });
    return b;
  };
  return { ...request, body: () => (read ??= body()) };
}

// (an event iterator: oRPC sends it as text/event-stream)
const isStream = (body: unknown): boolean => typeof body === 'object' && body !== null && Symbol.asyncIterator in body;

/** Answers a router's procedures the way the old routes answer: JSON, never cached, errors as { error }.
 *  maxBodySize: JSON_LIMIT, unless a test wants less. */
export function rpcHandler(router: AnyRouter, maxBodySize = JSON_LIMIT): OpenAPIHandler<Record<never, never>> {
  return new OpenAPIHandler(router, {
    plugins: [new BodyLimitPlugin({ maxBodySize })],
    // (the body is read only once a route matches: one that isn't ours keeps its body unread)
    interceptors: [({ next, request, ...rest }) => next({ ...rest, request: oldBody(request) })],
    clientInterceptors: [
      async ({ next }) => {
        try {
          return await next();
        } catch (e) {
          throw rpcError(e);
        }
      },
    ],
    // (around everything, so error answers get it too)
    rootInterceptors: [
      async ({ next }) => {
        const result = await next();
        if (!result.matched) return result;
        result.response.headers['cache-control'] = 'no-store';
        // a stream (the chats' runs, the Brain's answer) goes out as it is written, even through a proxy that
        // would otherwise hold it back (nginx)
        if (isStream(result.response.body)) result.response.headers['x-accel-buffering'] = 'no';
        return result;
      },
    ],
    customErrorResponseBodyEncoder: (e) => ({ error: rpcErrorMessage(e) }),
  });
}

const handler = rpcHandler(apiRouter);

/** Answers the request if it is an oRPC route. `prefix` is what comes before the route's own path:
 *  '/api', or '/api/p/<project>' for a request run in a project that isn't open. */
export async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse, prefix: `/${string}`): Promise<boolean> {
  const { matched } = await handler.handle(req, res, { prefix, context: {} });
  return matched;
}
