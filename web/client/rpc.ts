// Typed calls to the routes that moved to oRPC (shared/api/): rpc.taskBoard.addTag({ projectId, name }).
// Each one is sent the way api() sends a request, to the same address, and fails the same way: an Error with
// the server's own words and the HTTP status.
import { createORPCClient, ORPCError } from '@orpc/client';
import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from '../../shared/api/index.ts';
import { requestHeaders, serverUrl } from './connection.ts';

// oRPC builds a full Request for this made-up origin; send() swaps it for the connection's address.
const ORIGIN = 'http://dashboard.invalid';

/** The server's { error } words when there are some, as api() reads them (JSON whatever the content type). */
function serverWords(e: ORPCError<string, unknown>): string {
  const data: unknown = e.data;
  let body = data && typeof data === 'object' && 'body' in data ? data.body : undefined;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // (plain text: no words of its own)
    }
  }
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && body.error ? body.error : e.message;
}

/** A refused call as api() throws it: an Error with the server's message and its `status`. */
export function apiError(e: unknown): unknown {
  return e instanceof ORPCError ? Object.assign(new Error(serverWords(e)), { status: e.status }) : e;
}

// fetch(address, { method, headers, body }) like api(): requests look the same to the server and to tests
async function send(request: Request): Promise<Response> {
  const at = new URL(request.url);
  const type = request.headers.get('content-type') || '';
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : type.includes('json') ? await request.text() : await request.blob();
  return fetch(serverUrl(at.pathname + at.search), {
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: body === '' || (body instanceof Blob && !body.size) ? undefined : body,
    signal: request.signal,
  });
}

/** A typed client for a contract (the app's is `rpc`). */
export function rpcClient<C extends AnyContractRouter>(c: C): ContractRouterClient<C> {
  return createORPCClient(
    new OpenAPILink(c, {
      url: `${ORIGIN}/api`,
      headers: requestHeaders,
      fetch: send,
      interceptors: [
        async ({ next }) => {
          try {
            return await next();
          } catch (e) {
            throw apiError(e);
          }
        },
      ],
    }),
  );
}

export const rpc = rpcClient(contract);
