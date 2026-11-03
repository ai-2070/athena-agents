// The real server under Bun, on a spare port, with throwaway data and home folders:
// the API works and the local-only security checks hold.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { GatewayHealth, GatewayInstance, GatewayDiscordRecovery, GatewayRequestReview, GatewayWhatsAppSetup } from '../../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
// set in beforeAll: a port nothing else is using (see startServer)
let port = 0;
let base = '';
let proc: ChildProcess | undefined;
let tmp: string;

const req = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, init);
const json = { 'content-type': 'application/json', 'x-dash': '1' };

// A port the system says is free right now.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

// CLI probes can outlive the server, so stop its isolated process tree too.
async function stopServer(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); }
    catch (e) { if (!(e instanceof Error) || !('code' in e) || e.code !== 'ESRCH') throw e; }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    if (process.platform !== 'win32') signalGroup('SIGKILL');
    return;
  }
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    await once(killer, 'close');
    await closed;
    return;
  }
  const force = setTimeout(() => signalGroup('SIGKILL'), 3_000);
  try {
    signalGroup('SIGTERM');
    await closed;
    signalGroup('SIGKILL');
  } finally {
    clearTimeout(force);
  }
}

// Start our own server and wait until it answers. Another dashboard (another test run, another checkout)
// may grab the port first: then ours exits and the one answering isn't ours (other data folder), so try again.
// (all attempts together stay within START_MS, well under beforeAll's timeout)
const START_MS = 45_000;
async function startServer(home: string): Promise<void> {
  const deadline = Date.now() + START_MS;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    port = await freePort();
    base = `http://localhost:${port}`;
    const child = spawn('bun', ['server/index.ts', '--port', String(port), '--no-open'], {
      cwd: root,
      detached: process.platform !== 'win32',
      env: { ...process.env, DASH_DATA: path.join(tmp, 'data'), HOME: home, USERPROFILE: home },
      stdio: 'ignore',
    });
    proc = child;
    let exited = false;
    child.once('exit', () => (exited = true));
    for (let i = 0; i < 100 && !exited && Date.now() < deadline; i++) {
      try {
        const r = await req('/api/state');
        if (r.ok && String(((await r.json()) as { dataDir?: string }).dataDir || '').startsWith(tmp)) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await stopServer(child);
  }
  throw new Error('the server did not start');
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-api-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  await startServer(home);
}, 60_000);

afterAll(async () => {
  if (proc) await stopServer(proc);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('API', () => {
  it('serves the state the page needs', async () => {
    const st = await (await req('/api/state')).json();
    expect(st.project.name).toBe('My workspace');
    expect(st.agents).toEqual([]);
    expect(st.port).toBe(port);
    expect(st.dataDir.startsWith(tmp)).toBe(true);
  });

  it("refuses a change made for a project that is no longer open (finding 19)", async () => {
    const st = await (await req('/api/state')).json();
    const stale = await req('/api/agents', { method: 'POST', headers: { ...json, 'x-dash-project': 'another-project' }, body: JSON.stringify({ name: 'Stale' }) });
    expect(stale.status).toBe(409);
    const agents = await (await req('/api/agents')).json();
    expect(agents.some((a: { name: string }) => a.name === 'Stale')).toBe(false);
    const fresh = await req('/api/agents', { method: 'POST', headers: { ...json, 'x-dash-project': st.project.id }, body: JSON.stringify({ name: 'Fresh' }) });
    expect(fresh.status).toBe(200);
    await req(`/api/agents/${(await fresh.json()).id}`, { method: 'DELETE', headers: json });
  });

  it('creates an agent and a team', async () => {
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Tester' }) })).json();
    expect(a.id).toMatch(/^tester-/);
    const t = await (await req('/api/workflows', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Crew', members: [a.id], lead: a.id }) })).json();
    const list = await (await req('/api/workflows')).json();
    expect(list.find((x: { id: string }) => x.id === t.id)).toMatchObject({ name: 'Crew', members: [a.id] });
  });

  it('creates, lists, reads and updates persistent tasks through the real API', async () => {
    const created = await req('/api/tasks', { method: 'POST', headers: json, body: JSON.stringify({ subject: 'API task', description: 'Check the real task routes.' }) });
    expect(created.status).toBe(200);
    const { task } = await created.json();
    expect((await (await req(`/api/tasks/${task.id}`)).json()).task.subject).toBe('API task');
    const page = await (await req('/api/tasks?view=all&status=open')).json();
    expect(page.tasks.some((t: { id: string }) => t.id === task.id)).toBe(true);
    const update = await req(`/api/tasks/${task.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ status: 'completed', expectedUpdatedAt: task.updatedAt }) });
    expect((await update.json()).task.status).toBe('completed');
    const stale = await req(`/api/tasks/${task.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ subject: 'stale', expectedUpdatedAt: task.updatedAt }) });
    expect(stale.status).toBe(409);
    const invalid = await req('/api/tasks', { method: 'POST', headers: json, body: JSON.stringify({ subject: '' }) });
    expect(invalid.status).toBe(400);
    const unsafe = await req(`/api/tasks/${task.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) });
    expect(unsafe.status).toBe(403);
  });

  it('deletes a team with its agents, but keeps agents that are on another team', async () => {
    const send = async (method: string, p: string, body?: unknown) => (await req(p, { method, headers: json, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const solo = await send('POST', '/api/agents', { name: 'Only Here' });
    const shared = await send('POST', '/api/agents', { name: 'Also Elsewhere' });
    const t = await send('POST', '/api/workflows', { name: 'Doomed', members: [solo.id, shared.id], lead: solo.id });
    const other = await send('POST', '/api/workflows', { name: 'Survivor', members: [shared.id] });
    expect((await send('DELETE', `/api/workflows/${t.id}`)).deletedAgents).toEqual([solo.id]);
    expect((await req(`/api/agents/${solo.id}`)).status).toBe(404);
    expect((await req(`/api/agents/${shared.id}`)).ok).toBe(true);
    expect((await send('GET', `/api/workflows/${other.id}`)).members).toEqual([shared.id]);
    expect((await req(`/api/workflows/${t.id}`)).status).toBe(404);
  });

  it("keeps a team's emoji symbol, and a picture or model only through its own route", async () => {
    const send = async (method: string, p: string, body?: unknown) => req(p, { method, headers: json, ...(body ? { body: JSON.stringify(body) } : {}) });
    const a = await (await send('POST', '/api/agents', { name: 'Symbol Tester' })).json();
    const t = await (await send('POST', '/api/workflows', { name: 'Symbols', members: [a.id], lead: a.id, mark: '🎬' })).json();
    expect(t.mark).toBe('🎬');
    // anything that is not an emoji falls back to the default (empty)
    expect((await (await send('PUT', `/api/workflows/${t.id}`, { mark: '@' })).json()).mark).toBe('');
    // saving a team cannot make it point at a file: markFile only comes from the picture/model route
    const spoof = await (await send('PUT', `/api/workflows/${t.id}`, { markFile: { kind: 'image', ext: 'png', at: 1 } })).json();
    expect(spoof.markFile ?? null).toBeNull();
    expect((await send('GET', `/api/workflows/${t.id}/mark`)).status).toBe(404);
    // a real picture goes in, comes back out, and saving the team afterwards keeps it
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const saved = await (await send('POST', `/api/workflows/${t.id}/mark`, { name: 'badge.png', data: png })).json();
    expect(saved.markFile).toMatchObject({ kind: 'image', ext: 'png' });
    expect((await send('GET', `/api/workflows/${t.id}/mark`)).headers.get('content-type')).toBe('image/png');
    expect((await (await send('PUT', `/api/workflows/${t.id}`, { description: 'x' })).json()).markFile).toMatchObject({ kind: 'image' });
    expect((await send('POST', `/api/workflows/${t.id}/mark`, { name: 'bad.png', data: 'data:image/png;base64,AAAA' })).status).toBeGreaterThanOrEqual(400);
    expect((await (await send('DELETE', `/api/workflows/${t.id}/mark`)).json()).markFile).toBeNull();
    expect((await send('GET', `/api/workflows/${t.id}/mark`)).status).toBe(404);
  });

  it('makes and edits a routine that mentions an agent and a team', async () => {
    // its own agent and team, so this test runs on its own too
    const post = async (p: string, body: unknown) => (await req(p, { method: 'POST', headers: json, body: JSON.stringify(body) })).json();
    const a = await post('/api/agents', { name: 'Routine Tester' });
    await post('/api/workflows', { name: 'Routine Crew', members: [a.id], lead: a.id });
    const empty = await req('/api/routines', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Daily' }) });
    expect(empty.status).toBe(400);
    const created = await req('/api/routines', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Daily', text: 'Check the launch.' }) });
    expect(created.status).toBe(200);
    const r = await created.json();
    // A valid routine with nobody mentioned cannot run yet.
    expect((await req(`/api/routines/${r.id}/run`, { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    const saved = await (await req(`/api/routines/${r.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ text: 'Have @Routine Tester and @Routine Crew check in.' }) })).json();
    expect(saved.mentions.map((m: { kind: string; name: string }) => `${m.kind}:${m.name}`)).toEqual(['agent:Routine Tester', 'team:Routine Crew']);
    const list = await (await req('/api/routines')).json();
    expect(list.find((x: { id: string }) => x.id === r.id)).toMatchObject({ name: 'Daily', lastRun: null });
    expect((await req('/api/routines/nope')).status).toBe(404);
    expect((await req(`/api/routines/${r.id}`, { method: 'DELETE', headers: json })).status).toBe(200);
  });

  it('never sends secrets to the browser', async () => {
    await req('/api/secrets', { method: 'POST', headers: json, body: JSON.stringify({ key: 'openrouterKey', value: 'sk-or-v1-supersecretvalue9999' }) });
    const text = await (await req('/api/state')).text();
    expect(text).not.toContain('supersecretvalue');
    expect(JSON.parse(text).secrets.openrouterKey).toEqual({ set: true, hint: '…9999' });
    await req('/api/secrets', { method: 'POST', headers: json, body: JSON.stringify({ key: 'veniceKey', value: 'venice-supersecretvalue4321' }) });
    const venice = await (await req('/api/state')).text();
    expect(venice).not.toContain('supersecretvalue');
    expect(JSON.parse(venice).secrets.veniceKey).toEqual({ set: true, hint: '…4321' });
    await req('/api/secrets', { method: 'POST', headers: json, body: JSON.stringify({ key: 'veniceKey', value: '' }) });
    expect((await (await req('/api/state')).json()).secrets.veniceKey).toEqual({ set: false });
  });

  it('answers 404 for unknown routes and 400 for bad bodies', async () => {
    const venice = await req('/api/settings/test-venice', { method: 'POST', headers: json });
    expect(venice.status).toBe(400);
    expect(await venice.text()).toContain('No Venice key saved');
    expect((await req('/api/nope')).status).toBe(404);
    expect((await req('/api/agents', { method: 'POST', headers: json, body: '{oops' })).status).toBe(400);
    expect((await req('/api/agents', { method: 'POST', headers: json, body: 'null' })).status).toBe(400);
  });
});

describe('gateway configuration API', () => {
  it('dismisses only a current paused unstarted request behind the existing request guards', async () => {
    const state = await (await req('/api/state')).json() as { project: { id: string } };
    const config = { name: 'Held request', platform: 'telegram', accountId: '9800000001', projectId: state.project.id, target: { kind: 'brain' },
      senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
      fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false };
    const instance = await (await req('/api/gateways', { method: 'POST', headers: json, body: JSON.stringify(config) })).json() as GatewayInstance;
    const directory = path.join(tmp, 'data', 'gateways-runtime', instance.id); fs.mkdirSync(directory, { recursive: true });
    const route = { instanceId: instance.id, projectId: instance.projectId, target: instance.target, generation: instance.routeGeneration }; const eventId = 'a'.repeat(64);
    fs.writeFileSync(path.join(directory, 'inbox.json'), JSON.stringify({ version: 1, nextSequence: 2,
      bindings: [{ id: 'binding', accountId: instance.accountId, conversationId: '123', threadId: '', route, createdAt: 1 }],
      events: [{ id: eventId, bindingId: 'binding', route, sequence: 1, receivedAt: 1, status: 'needs-review',
        input: { platform: 'telegram', accountId: instance.accountId, conversationId: '123', threadId: '', sourceMessageId: '1', sourceEventId: '1', kind: 'message',
          actor: { id: '123', label: 'Alice', kind: 'user' }, directMessage: true, triggered: false, text: 'Saved request', media: [] } }],
    }));
    const base = `/api/gateways/${instance.id}/inbox/${eventId}`; const preview = await (await req(`${base}/review`)).json() as GatewayRequestReview;
    expect(preview).toMatchObject({ canDismiss: true, reason: '' }); expect(preview.revision).toMatch(/^[a-f0-9]{64}$/);
    const body = JSON.stringify({ revision: preview.revision, acknowledgeDismiss: true });
    expect((await req(`${base}/dismiss`, { method: 'POST', body })).status).toBe(403);
    expect((await req(`${base}/dismiss`, { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
    expect((await req(`${base}/dismiss`, { method: 'POST', headers: json, body: JSON.stringify({ revision: preview.revision }) })).status).toBe(409);
    expect((await req(`${base}/dismiss`, { method: 'POST', headers: json, body })).status).toBe(200);
    expect((await req(`${base}/dismiss`, { method: 'POST', headers: json, body })).status).toBe(409);
    const saved = await (await req(`/api/gateways/${instance.id}/inbox`)).json() as { events: { input: { text: string }; dismissed: { revision: string }; operationId?: string }[] };
    expect(saved.events[0]).toMatchObject({ input: { text: 'Saved request' }, dismissed: { revision: preview.revision } }); expect(saved.events[0].operationId).toBeUndefined();
    const navigation = await (await req('/api/state')).json() as { gateways: { id: string; status: string; reviewCount: number }[] };
    expect(navigation.gateways.find((item) => item.id === instance.id)).toMatchObject({ status: 'paused', reviewCount: 0 });
    await req(`/api/gateways/${instance.id}`, { method: 'DELETE', headers: json });
  });

  it('guards paused WhatsApp pairing finish and unknown-attempt review without exposing keys or private pairing metadata', async () => {
    const state = await (await req('/api/state')).json() as { project: { id: string } };
    const config = { name: 'WhatsApp pairing', platform: 'whatsapp', accountId: '9500000001', projectId: state.project.id, target: { kind: 'brain' },
      senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
      fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false };
    const instance = await (await req('/api/gateways', { method: 'POST', headers: json, body: JSON.stringify(config) })).json() as GatewayInstance;
    const url = `/api/gateways/${instance.id}`; const file = path.join(tmp, 'data', 'gateway-secrets.json');
    const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {};
    const connection = { origin: 'https://private-relay.example', installationId: '00000000-0000-4000-8000-000000000002', businessAccountId: '9000000001', phoneNumberId: instance.accountId, epoch: '00000000-0000-4000-8000-000000000001' };
    records[instance.id] = { relayKey: 'b'.repeat(64), whatsappPairing: { phase: 'received', attemptId: '00000000-0000-4000-8000-000000000003', connection, cursor: 0, gap: false } };
    fs.writeFileSync(file, JSON.stringify(records));
    const text = await (await req(`${url}/whatsapp-setup`)).text(); expect(text).not.toContain('private-relay'); expect(text).not.toContain('b'.repeat(64)); expect(text).not.toContain(connection.epoch);
    const preview = JSON.parse(text) as GatewayWhatsAppSetup; expect(preview).toMatchObject({ paired: false, pending: { phase: 'received' } });
    const listing = await (await req('/api/gateways')).text(); expect(listing).not.toContain('whatsappPairing'); expect(listing).not.toContain('b'.repeat(64));
    for (const suffix of ['/whatsapp-pairing', '/whatsapp-pairing/finish', '/whatsapp-pairing/review', '/whatsapp-recovery', '/whatsapp-recovery/inspect']) {
      expect((await req(url + suffix, { method: 'POST', body: '{}' })).status).toBe(403);
      expect((await req(url + suffix, { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status).toBe(403);
    }
    expect((await req(`${url}/whatsapp-pairing/finish`, { method: 'POST', headers: json, body: JSON.stringify({ revision: 'a'.repeat(64) }) })).status).toBe(409);
    const body = JSON.stringify({ revision: preview.pending!.revision });
    expect(await (await req(`${url}/whatsapp-pairing/finish`, { method: 'POST', headers: json, body })).json()).toEqual({ paired: true, pending: null, recoveryRequired: false });
    expect((await req(`${url}/whatsapp-pairing/finish`, { method: 'POST', headers: json, body })).status).toBe(409);
    expect((await req(`${url}/whatsapp-pairing`, { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    const inboxFile = path.join(tmp, 'data', 'gateways-runtime', instance.id, 'inbox.json');
    const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')) as { whatsappRelay: Record<string, unknown> };
    inbox.whatsappRelay.recovery = { at: Date.now(), reason: 'gap' }; inbox.whatsappRelay.gapReview = { at: Date.now(), from: 0, through: 2, remoteCursor: 0 };
    fs.writeFileSync(inboxFile, JSON.stringify(inbox));
    const recoveryText = await (await req(`${url}/whatsapp-recovery`)).text(); expect(recoveryText).not.toContain('private-relay'); expect(recoveryText).not.toContain('cursor'); expect(recoveryText).not.toContain('b'.repeat(64));
    expect(JSON.parse(recoveryText)).toMatchObject({ reason: 'gap', gap: { revision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await req(`${url}/whatsapp-recovery`, { method: 'POST', headers: json, body: JSON.stringify({ revision: 'a'.repeat(64), acknowledgeGap: true }) })).status).toBe(409);
    await req(url, { method: 'DELETE', headers: json });
    const other = await (await req('/api/gateways', { method: 'POST', headers: json, body: JSON.stringify({ ...config, accountId: '9500000002' }) })).json() as GatewayInstance;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    current[other.id] = { whatsappPairing: { phase: 'requesting', attemptId: '00000000-0000-4000-8000-000000000004', origin: 'https://relay.example', businessAccountId: '9000000001', phoneNumberId: other.accountId } }; fs.writeFileSync(file, JSON.stringify(current));
    const pending = await (await req(`/api/gateways/${other.id}/whatsapp-setup`)).json() as GatewayWhatsAppSetup;
    expect((await req(`/api/gateways/${other.id}/whatsapp-pairing/review`, { method: 'POST', headers: json, body: JSON.stringify({ revision: pending.pending!.revision }) })).status).toBe(409);
    expect(await (await req(`/api/gateways/${other.id}/whatsapp-pairing/review`, { method: 'POST', headers: json, body: JSON.stringify({ revision: pending.pending!.revision, acknowledgeRemoteRevoked: true }) })).json()).toEqual({ paired: false, pending: null, recoveryRequired: false });
    await req(`/api/gateways/${other.id}`, { method: 'DELETE', headers: json });
  });

  it('guards explicit Discord recovery review and never exposes its private session', async () => {
    const state = await (await req('/api/state')).json() as { project: { id: string } };
    const config = { name: 'Discord recovery', platform: 'discord', accountId: '900000000000000001', projectId: state.project.id, target: { kind: 'brain' },
      senderPolicy: { platform: 'discord', allowedUserIds: [] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
      fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false };
    const instance = await (await req('/api/gateways', { method: 'POST', headers: json, body: JSON.stringify(config) })).json() as GatewayInstance;
    const directory = path.join(tmp, 'data', 'gateways-runtime', instance.id); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'discord-gateway.json');
    const saved = { version: 1, accountId: instance.accountId, intents: 1 | 512 | 4096 | 32768, session: { id: 'PRIVATE_SESSION', url: 'wss://gateway.discord.gg/', sequence: 42 }, gap: { at: Date.now(), reason: 'session-lost' } };
    fs.writeFileSync(file, JSON.stringify(saved)); const url = `/api/gateways/${instance.id}/discord-recovery`;
    const preview = await (await req(url)).json() as GatewayDiscordRecovery; expect(preview.gap?.revision).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(preview)).not.toContain('PRIVATE_'); expect(JSON.stringify(preview)).not.toContain('discord.gg');
    const body = JSON.stringify({ revision: preview.gap!.revision, acknowledgeGap: true });
    expect((await req(url, { method: 'POST', body })).status).toBe(403);
    expect((await req(url, { method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
    expect((await req(url, { method: 'POST', headers: json, body: JSON.stringify({ revision: 'a'.repeat(64), acknowledgeGap: true }) })).status).toBe(409);
    expect((await req(url, { method: 'POST', headers: json, body })).status).toBe(200); expect(await (await req(url)).json()).toEqual({ gap: null });
    expect((await req(url, { method: 'POST', headers: json, body })).status).toBe(409);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { session?: unknown; reviewedGaps: unknown[] }; expect(after.session).toBeUndefined(); expect(after.reviewedGaps).toHaveLength(1);
    await req(`/api/gateways/${instance.id}`, { method: 'DELETE', headers: json });
  });

  it('keeps multiple instances and credentials separate behind the existing request guards', async () => {
    const state = await (await req('/api/state')).json() as { project: { id: string } };
    const config = {
      name: 'First Telegram', platform: 'telegram', accountId: '30000', projectId: state.project.id,
      target: { kind: 'brain' }, senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] },
      scope: { directMessages: true, conversationIds: [], guildIds: [] },
      fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false,
    };
    const unguarded = await req('/api/gateways', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
    expect(unguarded.status).toBe(403);
    const create = async (body: unknown) => req('/api/gateways', { method: 'POST', headers: json, body: JSON.stringify(body) });
    const one = await (await create(config)).json() as GatewayInstance;
    const targets = await req(`/api/gateways/targets/${state.project.id}`);
    expect(targets.status).toBe(200);
    expect(await targets.json()).toMatchObject({ agents: expect.any(Array), teams: expect.any(Array) });
    expect((await req('/api/gateways/targets/missing')).status).toBe(400);
    const two = await (await create({ ...config, name: 'Second Telegram', accountId: '30001' })).json() as GatewayInstance;
    expect(one.id).not.toBe(two.id);
    expect((await create(config)).status).toBe(400);
    const credentials = await req(`/api/gateways/${one.id}/credentials`, { method: 'PUT', headers: json, body: JSON.stringify({ botToken: 'private-gateway-token' }) });
    expect(await credentials.json()).toEqual({ botToken: true });
    expect((await req(`/api/gateways/${one.id}/credentials`, { method: 'POST', body: JSON.stringify({ appToken: 'private-app-token' }) })).status).toBe(403);
    expect(await (await req(`/api/gateways/${one.id}/credentials`, { method: 'POST', headers: json, body: JSON.stringify({ appToken: 'private-app-token' }) })).json()).toEqual({ botToken: true, appToken: true });
    expect(await (await req(`/api/gateways/${one.id}/credentials`, { method: 'POST', headers: json, body: JSON.stringify({ appToken: null }) })).json()).toEqual({ botToken: true });
    const listing = await req('/api/gateways');
    const listed = await listing.json() as { instances: (GatewayInstance & { credentials: Record<string, boolean> })[]; health: GatewayHealth[] };
    expect(JSON.stringify(listed)).not.toContain('private-gateway-token');
    expect(listed.instances.find((instance) => instance.id === one.id)?.credentials).toEqual({ botToken: true });
    expect(listed.instances.find((instance) => instance.id === two.id)?.credentials).toEqual({});
    const navigation = await (await req('/api/state')).json() as { gateways: { id: string; status: string; reviewCount: number | null }[] };
    expect(navigation.gateways.find((instance) => instance.id === one.id)).toMatchObject({ status: 'paused', reviewCount: 0 });
    expect(JSON.stringify(navigation.gateways)).not.toContain('private-gateway-token');
    expect(JSON.stringify(navigation.gateways)).not.toContain('credentials');
    expect((await create({ ...config, accountId: '30002', botToken: 'do-not-echo-this' })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/reconnect`, { method: 'POST', headers: json })).status).toBe(200);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/retry-files`, { method: 'POST', headers: json })).status).toBe(400);
    expect(await (await req(`/api/gateways/${one.id}/inbox`)).json()).toEqual({ events: [] });
    expect((await req(`/api/gateways/${one.id}/inbox/missing/retry-reply`, { method: 'POST', headers: json })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/retry-reply`, { method: 'POST' })).status).toBe(403);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/reconcile`, { method: 'POST' })).status).toBe(403);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/reconcile`, { method: 'POST', headers: json })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/group-album`, { method: 'POST' })).status).toBe(403);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/group-album`, { method: 'POST', headers: json, body: JSON.stringify({ eventIds: ['missing', 'other'] }) })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/cleanup`, { method: 'POST' })).status).toBe(403);
    expect((await req(`/api/gateways/${one.id}/inbox/cleanup`, { method: 'POST', headers: json, body: JSON.stringify({ before: Date.now(), eventIds: [] }) })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/files`, { method: 'POST', headers: json, body: JSON.stringify({ paths: ['file.txt'] }) })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/files/0/retry`, { method: 'POST', headers: json })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/files/0/skip`, { method: 'POST', headers: json })).status).toBe(400);
    expect((await req(`/api/gateways/${one.id}/inbox/missing/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['file.txt'] }) })).status).toBe(403);
    expect((await req(`/api/gateways/${one.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ ...config, name: 'Renamed Telegram' }) })).status).toBe(200);
    expect((await req(`/api/gateways/${one.id}`, { method: 'DELETE', headers: json })).status).toBe(200);
    const remaining = await (await req('/api/gateways')).json() as { instances: GatewayInstance[] };
    expect(remaining.instances.some((instance) => instance.id === one.id)).toBe(false);
    expect(remaining.instances.some((instance) => instance.id === two.id)).toBe(true);
    const secrets = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'gateway-secrets.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(secrets, one.id)).toBe(false);
    await req(`/api/gateways/${two.id}`, { method: 'DELETE', headers: json });
  });
});

describe('backups', () => {
  it('backs up a project into the home folder and restores it from an upload or from the backups folder', async () => {
    const st = await (await req('/api/state')).json();
    const made = await (await req(`/api/projects/${st.project.id}/backup`, { method: 'POST', headers: json })).json();
    expect(made.file.startsWith(path.join(tmp, 'home', 'Blacksite Backups'))).toBe(true);
    const list = await (await req('/api/backups')).json();
    expect(list.backups.map((b: { name: string }) => b.name)).toContain(made.name);

    const bytes = fs.readFileSync(made.file);
    // the file as the body: bigger than a JSON body may be is fine too, but it needs the x-dash header
    expect((await req('/api/backups/restore', { method: 'POST', body: bytes })).status).toBe(403);
    const up = await req('/api/backups/restore?name=From%20upload', { method: 'POST', headers: { 'x-dash': '1', 'content-type': 'application/octet-stream' }, body: bytes });
    expect(up.status).toBe(200);
    const p1 = await up.json();
    expect(p1).toMatchObject({ name: 'From upload', restored: { agents: made.summary.agents, teams: made.summary.teams } });

    const p2 = await (await req(`/api/backups/restore?file=${encodeURIComponent(made.name)}&name=From%20folder`, { method: 'POST', headers: { 'x-dash': '1' } })).json();
    expect(p2.name).toBe('From folder');
    expect(p2.brainPath).not.toBe(p1.brainPath);

    const bad = await req('/api/backups/restore', { method: 'POST', headers: { 'x-dash': '1' }, body: 'not a backup' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/isn't a dashboard backup/);
    expect((await req('/api/backups/restore?file=..%2Fsecrets.json', { method: 'POST', headers: { 'x-dash': '1' } })).status).toBe(400);
    expect((await req('/api/backups/restore', { method: 'POST', headers: { 'x-dash': '1' } })).status).toBe(400);
  });

  it('streams a restore upload to a temporary file and always removes it', async () => {
    const received = path.join(tmp, 'data', 'tmp', 'received');
    // bigger than a JSON body may be: it still arrives (and is turned away as not a backup)
    const big = Buffer.alloc(30 * 1024 * 1024, 0x61);
    const r = await req('/api/backups/restore', { method: 'POST', headers: { 'x-dash': '1', 'content-type': 'application/octet-stream' }, body: big });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/isn't a dashboard backup/);
    expect(fs.existsSync(received) ? fs.readdirSync(received) : []).toEqual([]);
    // and after a restore that worked
    const st = await (await req('/api/state')).json();
    const made = await (await req(`/api/projects/${st.project.id}/backup`, { method: 'POST', headers: json })).json();
    const ok = await req('/api/backups/restore?name=Streamed', { method: 'POST', headers: { 'x-dash': '1' }, body: fs.readFileSync(made.file) });
    expect(ok.status).toBe(200);
    expect(fs.readdirSync(received)).toEqual([]);
  });
});

describe('skills from plain words', () => {
  it('asks for words or files before calling the Brain', async () => {
    const r = await req('/api/assist/skill', { method: 'POST', headers: json, body: JSON.stringify({ text: '   ' }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/Say what the skill should do/);
    expect((await req('/api/assist/skill', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(403); // needs x-dash
  });
});

describe('local-only security', () => {
  it('rejects requests for another host name (DNS rebinding)', async () => {
    const r = await new Promise<number>((resolve) => {
      // fetch won't let us change Host, so use a raw request
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode || 0)).on('error', () => resolve(0));
    });
    expect(r).toBe(421);
  });

  it('needs the x-dash header for changes (no simple cross-site POSTs)', async () => {
    const r = await req('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) });
    expect(r.status).toBe(403);
  });

  it('blocks cross-site requests', async () => {
    const r = await req('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(r.status).toBe(403);
  });

  it('sends a strict content security policy with the page', async () => {
    const r = await req('/');
    const csp = r.headers.get('content-security-policy') || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // fonts come from here too
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('googleapis');
  });

  it('serves the page in the colour scheme you picked, and leaves it to the computer on System', async () => {
    const page = async () => (await req('/')).text();
    expect(await page()).toContain('<html lang="en">');
    // Settings > Appearance > Colour scheme
    const save = (theme: string) => req('/api/settings', { method: 'PUT', headers: json, body: JSON.stringify({ look: { theme } }) });
    expect((await save('dark')).status).toBe(200);
    expect(await page()).toContain('<html lang="en" data-theme="dark">');
    const settings = (await (await req('/api/settings')).json()) as { settings: { look: { theme: string } } };
    expect(settings.settings.look.theme).toBe('dark');
    // System: nothing on <html>, so the stylesheet follows the computer's own light or dark
    expect((await save('system')).status).toBe(200);
    expect(await page()).toContain('<html lang="en">');
  });

  it('accepts the live-events socket only from its own page', async () => {
    const open = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { origin } });
        ws.on('open', () => (ws.close(), resolve('open')));
        ws.on('error', () => resolve('refused'));
        ws.on('unexpected-response', () => resolve('refused'));
      });
    expect(await open(base)).toBe('open');
    expect(await open('https://evil.example')).toBe('refused');
  });

  it("won't serve files outside its own folders", async () => {
    expect((await req('/api/file?path=' + encodeURIComponent(path.join(root, 'package.json')))).status).toBeGreaterThanOrEqual(400);
    // fetch would normalise a plain "/../", so encode the slash: the server decodes it after parsing the URL
    expect((await req('/%2e%2e%2fpackage.json')).status).not.toBe(200);
    expect((await req('/..%2fpackage.json')).status).not.toBe(200);
  });

  it("won't delete files outside a collection's folder (encoded slash in an id)", async () => {
    const keep = path.join(tmp, 'data', 'keep.json');
    fs.writeFileSync(keep, '{}');
    await req('/api/outbox/..%2fkeep', { method: 'DELETE', headers: json });
    await req('/api/outbox/..%5ckeep', { method: 'DELETE', headers: json });
    expect(fs.existsSync(keep)).toBe(true);
  });
});

describe('attached files', () => {
  const upload = (batch: string, rel: string, data: string, headers: Record<string, string> = { 'x-dash': '1' }) => req(`/api/uploads/${batch}?path=${encodeURIComponent(rel)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body: data });

  it('saves dropped files and folders in the project folder, and never outside it', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    const st = await (await req('/api/state')).json();
    const root = path.join(st.project.brainPath, 'uploads', batch);
    const f = await (await upload(batch, 'brief.md', '# Brief')).json();
    expect(f.path).toBe(path.join(root, 'brief.md'));
    expect(fs.readFileSync(f.path, 'utf8')).toBe('# Brief');
    const sneaky = await (await upload(batch, '../../../escape.txt', 'x')).json();
    expect(sneaky.path).toBe(path.join(root, 'escape.txt'));
    const inFolder = await (await upload(batch, 'assets/logo.svg', '<svg/>')).json();
    expect(inFolder.top).toBe(path.join(root, 'assets') + path.sep);
    // the page can show it, and knows its size before reading it (to skip one too big to show)
    const shown = await req(`/api/file?path=${encodeURIComponent(f.path)}`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-length')).toBe('7');
    expect(await shown.text()).toBe('# Brief');
  });

  it('opens a PDF in a browser tab when asked (view=1); everything else still downloads, sandboxed', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    const pdf = await (await upload(batch, 'plan.pdf', '%PDF-1.4')).json();
    const note = await (await upload(batch, 'note.md', '# Hi')).json();
    const get = (p: string, view = '') => req(`/api/file?path=${encodeURIComponent(p)}${view}`);
    const plain = await get(pdf.path);
    expect(plain.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(plain.headers.get('content-security-policy')).toMatch(/sandbox/);
    const viewed = await get(pdf.path, '&view=1');
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get('content-type')).toBe('application/pdf');
    expect(viewed.headers.get('content-disposition')).toMatch(/^inline/);
    expect(viewed.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await viewed.text()).toBe('%PDF-1.4');
    // only PDFs: any other file asked for this way is still sent the safe way
    const md = await get(note.path, '&view=1');
    expect(md.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(md.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('needs the x-dash header to upload or remove, and removes only uploads', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    expect((await upload(batch, 'a.md', 'x', {})).status).toBe(403);
    expect((await req('/api/uploads', { method: 'POST' })).status).toBe(403);
    const st = await (await req('/api/state')).json();
    const brainMd = path.join(st.project.brainPath, 'BRAIN.md');
    expect((await req(`/api/uploads?path=${encodeURIComponent(brainMd)}`, { method: 'DELETE', headers: json })).status).toBe(403);
    expect(fs.existsSync(brainMd)).toBe(true);
  });

  it('sends attachments with agent and team messages (a message can be files only)', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    const f = await (await upload(batch, 'data.csv', 'a,b\n1,2')).json();
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Reader' }) })).json();
    const c = await (await req(`/api/agents/${a.id}/chats`, { method: 'POST', headers: json })).json();
    const outside = path.join(root, 'package.json');
    const sent = await req(`/api/agents/${a.id}/chats/${c.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: '', attachments: [f.path, outside] }) });
    expect(sent.status).toBe(200);
    const chat = await (await req(`/api/agents/${a.id}/chats/${c.id}`)).json();
    expect(chat.items[0]).toMatchObject({ type: 'user', text: '', attachments: [f.path] });
    expect(chat.title).toBe('data.csv');
    // nothing to send: no text, no (valid) files
    expect((await req(`/api/agents/${a.id}/chats/${c.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: ' ', attachments: [outside] }) })).status).toBe(400);

    const t = await (await req('/api/workflows', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Readers', members: [a.id], files: [f.path, outside] }) })).json();
    expect(t.files).toEqual([f.path]);
    const m = await (await req(`/api/teams/${t.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'Sum it', attachments: [f.path] }) })).json();
    expect(m).toMatchObject({ from: 'user', text: 'Sum it', attachments: [f.path] });
  });

  it('keeps memory information without the old compaction controls', async () => {
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Memory', engine: 'eve', provider: 'custom' }) })).json();
    const c = await (await req(`/api/agents/${a.id}/chats`, { method: 'POST', headers: json })).json();
    const path_ = `/api/agents/${a.id}/chats/${c.id}`;
    expect((await (await req(`${path_}/memory`)).json())).toMatchObject({ tokens: expect.any(Number), window: expect.any(Number), estimated: true });
    expect((await req(`${path_}/compact`, { method: 'POST', headers: json })).status).toBe(404);
    expect((await req(`${path_}/compactions/0`, { method: 'PUT', headers: json, body: '{}' })).status).toBe(404);
  });
});

describe('agent runs and projects', () => {
  it("tool calls through the MCP bridge stay in the run's project after you open another", async () => {
    // a fake model that holds its answer until the test lets it go
    let release = () => {};
    const model = http.createServer((rq, rs) => {
      if (rq.url?.endsWith('/models')) return rs.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      new Promise<void>((r) => (release = r)).then(() => {
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        rs.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
    try {
      const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();
      await send('/api/settings', { providers: { custom: { baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } } }, 'PUT');
      const home = path.join(tmp, 'home');
      const a = await send('/api/projects', { name: 'Bridge A', mode: 'new', folder: path.join(home, 'bridge-a') });
      const agent = await send('/api/agents', { name: 'Bridged', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: ['files'], autonomy: 'auto' });
      const chat = await send(`/api/agents/${agent.id}/chats`, {});
      const { runId } = await send(`/api/agents/${agent.id}/chats/${chat.id}/messages`, { text: 'hello' });
      const b = await send('/api/projects', { name: 'Bridge B', mode: 'new', folder: path.join(home, 'bridge-b') });
      expect((await (await req('/api/state')).json()).project.id).toBe(b.id);

      const internal = { 'content-type': 'application/json', 'x-dash-internal': fs.readFileSync(path.join(tmp, 'data', '.internal-token'), 'utf8').trim() };
      const tools = await (await req(`/api/internal/tools?agent=${agent.id}&run=${runId}`, { headers: internal })).json();
      // the run's own agent (files only), not the outside-client stand-in
      expect(tools.tools.map((t: { name: string }) => t.name)).toContain('write_file');
      expect(tools.tools.map((t: { name: string }) => t.name)).not.toContain('list_programs');
      const r = await (await req('/api/internal/tools/call', { method: 'POST', headers: internal, body: JSON.stringify({ agent: agent.id, run: runId, name: 'write_file', args: { path: 'bridge.txt', content: 'via-bridge' } }) })).json();
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(a.brainPath, 'bridge.txt'), 'utf8')).toBe('via-bridge');
      expect(fs.existsSync(path.join(b.brainPath, 'bridge.txt'))).toBe(false);
    } finally {
      release();
      await new Promise<void>((r) => model.close(() => r()));
    }
  });

  it('the MCP bridge gives an agent the tools its team gave it for the work', async () => {
    let release = () => {};
    const model = http.createServer((rq, rs) => {
      if (rq.url?.endsWith('/models')) return rs.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      new Promise<void>((r) => (release = r)).then(() => {
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        rs.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
    try {
      const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();
      await send('/api/settings', { providers: { custom: { baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } } }, 'PUT');
      // the agent has no Files tools of its own; its team gives them
      const agent = await send('/api/agents', { name: 'Team helper', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [], autonomy: 'auto' });
      const team = await send('/api/workflows', { name: 'File team', members: [agent.id], lead: agent.id, access: { toolGroups: ['files'] } });
      await send(`/api/teams/${team.id}/messages`, { text: `@${agent.name} write it down` });
      let run: { id: string; agentId: string } | undefined;
      for (let i = 0; i < 100 && !run; i++) {
        run = ((await (await req('/api/runs')).json()) as { id: string; agentId: string }[]).find((r) => r.agentId === agent.id);
        if (!run) await new Promise((r) => setTimeout(r, 50));
      }
      expect(run).toBeTruthy();
      const internal = { 'content-type': 'application/json', 'x-dash-internal': fs.readFileSync(path.join(tmp, 'data', '.internal-token'), 'utf8').trim() };
      const tools = await (await req(`/api/internal/tools?agent=${agent.id}&run=${run!.id}`, { headers: internal })).json();
      expect(tools.tools.map((t: { name: string }) => t.name)).toContain('list_files');
      const r = await req('/api/internal/tools/call', { method: 'POST', headers: internal, body: JSON.stringify({ agent: agent.id, run: run!.id, name: 'list_files', args: {} }) });
      expect(r.status).toBe(200);
      // without the run it is the agent's own tools only
      const own = await (await req(`/api/internal/tools?agent=${agent.id}`, { headers: internal })).json();
      expect(own.tools.map((t: { name: string }) => t.name)).not.toContain('list_files');
    } finally {
      release();
      await new Promise<void>((r) => model.close(() => r()));
    }
  });

  it('keeps versions of an agent, restores one, and brings back a deleted one', async () => {
    const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();
    const a = await send('/api/agents', { name: 'Api versions', systemPrompt: 'First.' });
    await send(`/api/agents/${a.id}`, { systemPrompt: 'Second.' }, 'PUT');
    const hist = await (await req(`/api/versions/agent/${a.id}`)).json();
    expect(hist.versions).toHaveLength(1);
    expect(hist.versions[0].changes).toEqual(['instructions']);
    const v = await (await req(`/api/versions/agent/${a.id}/${hist.versions[0].id}`)).json();
    expect(v.text).toContain('First.');
    // changes need the custom header, like every other change
    expect((await req(`/api/versions/agent/${a.id}/${v.id}/restore`, { method: 'POST' })).status).toBe(403);
    await send(`/api/versions/agent/${a.id}/${v.id}/restore`, {});
    expect((await (await req(`/api/agents/${a.id}`)).json()).systemPrompt).toBe('First.');
    await req(`/api/agents/${a.id}`, { method: 'DELETE', headers: json });
    expect((await (await req('/api/versions/agent')).json()).map((x: { id: string }) => x.id)).toContain(a.id);
    await send(`/api/versions/agent/${a.id}/undelete`, {});
    expect((await req(`/api/agents/${a.id}`)).ok).toBe(true);
    expect((await req('/api/versions/routine')).status).toBe(404);
  });
});

describe('effort and favorite models', () => {
  const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();

  it("reads and edits an agent's and the Brain's MEMORY.md, with history", async () => {
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Rememberer' }) })).json();
    const put = (owner: string, body: unknown, headers: Record<string, string> = json) => req(`/api/memory/${owner}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    expect(await (await req(`/api/memory/${a.id}`)).json()).toMatchObject({ owner: a.id, name: 'Rememberer', text: '', updatedAt: 0 });
    expect((await put(a.id, { text: '- Likes lists.' })).status).toBe(200);
    expect((await put(a.id, { text: '- Likes short lists.' })).status).toBe(200);
    expect(await (await req(`/api/memory/${a.id}`)).json()).toMatchObject({ text: '- Likes short lists.\n' });
    const hist = await (await req(`/api/versions/memory/${a.id}`)).json();
    expect(hist).toMatchObject({ kind: 'memory', current: '- Likes short lists.' });
    expect((await put('brain', { text: '- Keep it short.' })).status).toBe(200);
    expect((await (await req('/api/memory/brain')).json()).name).toBe('The Brain');
    // no such agent, no text, no x-dash header
    expect((await req('/api/memory/nobody')).status).toBe(404);
    expect((await put(a.id, { nope: 1 })).status).toBe(400);
    expect((await put(a.id, { text: 'x' }, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await req('/api/memory/..%2Fsecrets')).status).toBeGreaterThanOrEqual(400);
  });

  it('saves an effort level on an agent, and turns anything else into the default', async () => {
    const a = await send('/api/agents', { name: 'Effortful', effort: 'high' });
    expect(a.effort).toBe('high');
    expect((await send(`/api/agents/${a.id}`, { effort: 'max' }, 'PUT')).effort).toBe('max');
    expect((await send(`/api/agents/${a.id}`, { effort: 'warp' }, 'PUT')).effort).toBe('');
  });

  it('keeps favorite models in the settings', async () => {
    const favoriteModels = [{ engine: 'claude-code', model: 'opus' }, { engine: 'eve', provider: 'openrouter', model: 'x/y' }];
    expect((await send('/api/settings', { favoriteModels }, 'PUT')).favoriteModels).toEqual(favoriteModels);
    expect((await (await req('/api/state')).json()).settings.favoriteModels).toEqual(favoriteModels);
    expect((await send('/api/settings', { favoriteModels: [] }, 'PUT')).favoriteModels).toEqual([]);
  });

  it('keeps the requested effort level and reports unsupported options', async () => {
    const bodies: Record<string, unknown>[] = [];
    let refuse: false | 'http' | 'stream' | 'late' = false;
    const model = http.createServer((rq, rs) => {
      if (rq.url?.endsWith('/models')) return rs.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      let raw = '';
      rq.on('data', (d) => (raw += d));
      rq.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (JSON.stringify(body.messages).includes('You are Thinker')) bodies.push(body);
        if (refuse === 'http' && 'reasoning_effort' in body) {
          rs.writeHead(400, { 'content-type': 'application/json' });
          return rs.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }));
        }
        if (refuse === 'stream' && 'reasoning_effort' in body) {
          // a 200 whose stream carries the error (no HTTP status on it)
          rs.writeHead(200, { 'content-type': 'text/event-stream' });
          return rs.end(`data: ${JSON.stringify({ error: { message: 'reasoning_effort is not supported by this model' } })}\n\n`);
        }
        if (refuse === 'late' && 'reasoning_effort' in body) {
          // part of the answer, then an error: never asked again (it would show twice)
          rs.writeHead(200, { 'content-type': 'text/event-stream' });
          return rs.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'half' } }] })}\n\ndata: ${JSON.stringify({ error: { message: 'reasoning budget exceeded' } })}\n\n`);
        }
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        rs.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
    try {
      await send('/api/settings', { providers: { custom: { baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } } }, 'PUT');
      const agent = await send('/api/agents', { name: 'Thinker', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [], effort: 'max' });
      const ask = async (text: string) => {
        const chat = await send(`/api/agents/${agent.id}/chats`, {});
        await send(`/api/agents/${agent.id}/chats/${chat.id}/messages`, { text });
        for (let i = 0; i < 100; i++) {
          const items = (await (await req(`/api/agents/${agent.id}/chats/${chat.id}`)).json()).items as { type: string }[];
          if (items.some((x) => x.type === 'assistant' || x.type === 'error')) return items;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('no answer');
      };
      await ask('think hard');
      // max is more than an OpenAI-compatible server takes: it gets high
      expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'high' });
      expect(bodies.at(-1)).not.toHaveProperty('reasoning');

      for (const how of ['http', 'stream'] as const) {
        refuse = how;
        bodies.length = 0;
        const items = await ask(`again (${how})`);
        expect(items.some((x) => x.type === 'error')).toBe(true);
        expect(bodies.length).toBeGreaterThan(0);
        expect(bodies.length).toBeLessThanOrEqual(3);
        expect(bodies.every((body) => body.reasoning_effort === 'high')).toBe(true);
      }

      refuse = 'late';
      bodies.length = 0;
      const items = await ask('late error');
      expect(items.some((x) => x.type === 'error')).toBe(true);
      expect(bodies.length).toBeLessThanOrEqual(3);
      expect(bodies.every((body) => body.reasoning_effort === 'high')).toBe(true);
    } finally {
      await new Promise<void>((r) => model.close(() => r()));
    }
  });
});

describe('/ commands over the API', () => {
  const send = async (p: string, body: unknown = {}, method = 'POST') => req(p, { method, headers: json, body: JSON.stringify(body) });

  it('agent chats: /goal shows, /loop is checked, /resume and /resend say when there is nothing to do', async () => {
    const a = await (await send('/api/agents', { name: 'Cmd agent' })).json();
    const c = await (await send(`/api/agents/${a.id}/chats`)).json();
    const base_ = `/api/agents/${a.id}/chats/${c.id}`;
    expect(await (await send(`${base_}/goal`, { text: '' })).json()).toEqual({ goal: null });
    const loop = await send(`${base_}/loop`, { text: '10s too fast' });
    expect(loop.status).toBe(400);
    expect((await loop.json()).error).toBe('Loop at most once a minute.');
    expect((await send(`${base_}/resume`)).status).toBe(400);
    expect((await send(`${base_}/resend`)).status).toBe(400);
    const chat = await (await req(base_)).json();
    expect(chat).toMatchObject({ queued: [], loop: null, goal: null });
    expect(await (await req(`/api/agents/${a.id}/commands`)).json()).toEqual([]);
    // like every change, commands need the dashboard's header
    expect((await req(`${base_}/resume`, { method: 'POST' })).status).toBe(403);
  });

  it('the Brain chat: /resume with nothing stopped says so', async () => {
    const r = await send('/api/brain/resume', {});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Nothing to resume.');
    expect(await (await send('/api/brain/stop', { chats: 'not a list' })).json()).toEqual({ stopped: [] });
  });
});
