// The webhooks listener: its own server on its own port (the dashboard's + 1 unless set), on 127.0.0.1 only, so a
// tunnel can point at it without reaching the dashboard. It answers POST /h/<token> and GET /h/_check, and a bare 404
// to everything else: no /api/, no page, no WebSocket, nothing of the dashboard's router.
// It doesn't check Host (a tunnel sends its public name): nothing here works without a webhook's secret token.
import crypto from 'node:crypto';
import http from 'node:http';
import { bus, emit, getSettings, log } from '../store.ts';
import { PORT } from '../util.ts';
import { receive } from './intake.ts';
import { allWebhooks } from './store.ts';
import type { WebhookStatus } from '../../shared/types.ts';

export const MAX_BODY = 1024 * 1024;
/** Refused requests a minute before the listener stops reading any for a minute. */
const BRAKE = 60;
const TOKEN = /^\/h\/([A-Za-z0-9_-]{20,128})$/;

/** Changes for each start, so Check can tell this listener answered (and not something else on the address). */
let nonce = crypto.randomBytes(16).toString('hex');
let server: http.Server | null = null;
let port = 0;
let error: string | null = null;
/** --hooks-port */
let portArg: number | null = null;

let refusedAt: number[] = [];
let brakeUntil = 0;
let brakeLogged = 0;

export const checkNonce = (): string => nonce;
export const setHooksPortArg = (p: number | null): void => {
  portArg = p;
};

/** The port webhooks are received on: the setting, else --hooks-port, else the dashboard's + 1. */
export function webhookPort(): number {
  return getSettings().webhooks.port || portArg || PORT + 1;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
};
const notFound = (res: http.ServerResponse) => json(res, 404, { error: 'Not found.' });

function refused(now: number) {
  refusedAt = refusedAt.filter((t) => now - t < 60_000);
  refusedAt.push(now);
  if (refusedAt.length >= BRAKE) {
    brakeUntil = now + 60_000;
    refusedAt = [];
    if (now - brakeLogged > 60_000) {
      brakeLogged = now;
      log('error', `Webhooks: over ${BRAKE} refused requests in a minute. Not reading any for a minute.`);
    }
  }
}

const ACCEPTED = /^(application\/(json|[\w.+-]+\+json|x-www-form-urlencoded)|text\/[\w.+-]+)(;|$)/i;

/** Reads the body up to MAX_BODY; null when it is bigger. */
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const now = Date.now();
  const pathname = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && pathname === '/h/_check') return json(res, 200, { athena: 'webhooks', nonce });
  const m = req.method === 'POST' ? TOKEN.exec(pathname) : null;
  if (!m) return notFound(res);
  if (now < brakeUntil) return json(res, 429, { error: 'Too many refused requests. Try again later.' });
  const type = String(req.headers['content-type'] || '');
  if (type && !ACCEPTED.test(type)) return json(res, 415, { error: 'Send JSON, a form or text.' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(res, 413, { error: 'Too big.' });
  const body = await readBody(req);
  if (!body) return json(res, 413, { error: 'Too big.' });
  const reply = await receive({ token: m[1], headers: req.headers, body, now });
  if (reply.refused) refused(now);
  json(res, reply.status, reply.body);
}

/** Starts listening on a port (stops first if it listens on another). */
export function startListener(on: number): Promise<void> {
  if (server && port === on) return Promise.resolve();
  return stopListener().then(
    () =>
      new Promise<void>((resolve) => {
        const s = http.createServer((req, res) => {
          handle(req, res).catch((e: unknown) => {
            log('error', `Webhooks: ${e instanceof Error ? e.message : String(e)}`);
            if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
            else res.destroy();
          });
        });
        s.requestTimeout = 15_000;
        s.headersTimeout = 10_000;
        s.once('error', (e: NodeJS.ErrnoException) => {
          error =
            e.code === 'EADDRINUSE'
              ? `Port ${on} is in use. Pick another port for webhooks.`
              : `Couldn't listen on port ${on}: ${e.message}`;
          server = null;
          log('error', `Webhooks: ${error}`);
          emit('webhook-status');
          resolve();
        });
        s.listen(on, '127.0.0.1', () => {
          server = s;
          port = (s.address() as { port: number }).port;
          error = null;
          nonce = crypto.randomBytes(16).toString('hex');
          log('system', `Webhooks: listening on 127.0.0.1:${port}`);
          emit('webhook-status');
          resolve();
        });
      }),
  );
}

export function stopListener(): Promise<void> {
  const s = server;
  server = null;
  port = 0;
  if (!s) return Promise.resolve();
  return new Promise<void>((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  }).then(() => {
    emit('webhook-status');
  });
}

/** Is the listener wanted: webhooks on, and at least one webhook on, in any project. */
export function listenerWanted(): boolean {
  return getSettings().webhooks.on && allWebhooks().some((h) => h.enabled);
}

let syncing: Promise<void> = Promise.resolve();
/** Starts or stops the listener to match the settings and webhooks. */
export function syncListener(): Promise<void> {
  syncing = syncing.then(async () => {
    if (!listenerWanted()) {
      error = null;
      await stopListener();
      return;
    }
    if (dashboardPort(webhookPort())) {
      error = `Port ${webhookPort()} is the dashboard's. Pick another port for webhooks.`;
      await stopListener();
      return;
    }
    await startListener(webhookPort());
  });
  return syncing;
}

const dashboardPort = (p: number) => p === PORT;

export function listenerStatus(): WebhookStatus {
  const s = getSettings().webhooks;
  return {
    on: s.on,
    listening: !!server,
    port: server ? port : webhookPort(),
    publicUrl: s.publicUrl,
    error,
  };
}

/** Keeps the listener in step with changes to the settings and webhooks while the dashboard runs. */
export function watchWebhooks(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  bus.on('event', (e) => {
    if (e.type !== 'webhooks' && e.type !== 'settings') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncListener(), 200);
    timer.unref?.();
  });
}
