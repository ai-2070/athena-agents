// Typed calls to the routes that moved to oRPC (shared/api/): rpc.taskBoard.addTag({ projectId, name }).
// Each one is sent the way api() sends a request, to the same address, and fails the same way: an Error with
// the server's own words and the HTTP status.
import { createORPCClient, ORPCError, type ClientContext } from '@orpc/client';
import type { StandardLinkClient } from '@orpc/client/standard';
import type { AnyContractRouter, ContractRouterClient } from '@orpc/contract';
import { StandardOpenAPILink } from '@orpc/openapi-client/standard';
import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@orpc/standard-server-fetch';
import { contract } from '../../shared/api/index.ts';
import { requestHeaders, serverUrl } from './connection.ts';

// oRPC builds each request's address on this made-up origin; client.call() swaps it for the connection's.
const ORIGIN = 'http://dashboard.invalid';

/** The server's { error } words when there are some, as api() reads them. */
function serverWords(e: ORPCError<string, unknown>): string {
  const data: unknown = e.data;
  const body = data && typeof data === 'object' && 'body' in data ? data.body : undefined;
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && body.error
    ? body.error
    : e.message;
}

/** A refused call as api() throws it: an Error with the server's message and its `status`. */
export function apiError(e: unknown): unknown {
  return e instanceof ORPCError ? Object.assign(new Error(serverWords(e)), { status: e.status }) : e;
}

// fetch(address, { method, headers, body }) like api(): requests look the same to the server and to tests. The body
// goes as oRPC made it (JSON text once), never through a Request and back.
// The answer is read like api() reads it too: JSON whatever its content type says. (The routes always say JSON, so
// only a short answer without it, an empty one or a plain "Not found", is read twice.) A stream (the chats'
// runs) is handed on as it comes.
const client: StandardLinkClient<ClientContext> = {
  async call(request) {
    const headers = toFetchHeaders(request.headers);
    const body = toFetchBody(request.body, headers);
    const res = await fetch(serverUrl(request.url.pathname + request.url.search), {
      method: request.method,
      headers: Object.fromEntries(headers.entries()),
      body,
      signal: request.signal,
    });
    return toStandardLazyResponse(await asJson(res), { signal: request.signal });
  },
};

async function asJson(res: Response): Promise<Response> {
  const type = res.headers.get('content-type') || '';
  if (type.includes('json') || type.includes('event-stream')) return res;
  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json');
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

/** A typed client for a contract (the app's is `rpc`). at: '/p/<project>' to run calls in a project that
 *  isn't open (projectAt() in connection.ts), '' for the open one. */
export function rpcClient<C extends AnyContractRouter>(c: C, at = ''): ContractRouterClient<C> {
  return createORPCClient(
    new StandardOpenAPILink(c, client, {
      url: `${ORIGIN}/api${at}`,
      headers: requestHeaders,
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

const elsewhere = new Map<string, typeof rpc>();
/** The calls, run in the project `at` names ('/p/<project>', from projectAt()); '' is the open project's: rpc. */
export function rpcAt(at: string): typeof rpc {
  if (!at) return rpc;
  let client = elsewhere.get(at);
  if (!client) elsewhere.set(at, (client = rpcClient(contract, at)));
  return client;
}
