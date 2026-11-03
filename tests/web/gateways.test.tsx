import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewaysTab } from '../../web/views/gateways.tsx';
import type { GatewayHealth, GatewayInstance, GatewayDiscordRecovery } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement; let unmount: () => void;
let instances: (GatewayInstance & { credentials: Record<string, boolean> })[];
let requests: { url: string; method: string; body: Record<string, unknown> }[];
let failToken: boolean; let health: GatewayHealth[]; let recovery: GatewayDiscordRecovery; let failRecovery: boolean;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (name: string, root: ParentNode = host) => [...root.querySelectorAll('button')].find((item) => item.textContent === name)!;
const input = (name: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`)!;
async function type(name: string, value: string) {
  await act(async () => { const field = input(name); Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!; requests = []; instances = []; failToken = false; health = []; recovery = { gap: { at: 1700000000000, revision: 'a'.repeat(64) } }; failRecovery = false;
  location.hash = '#/settings?tab=gateways';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'; const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
    requests.push({ url, method, body });
    let result: unknown = {};
    if (url === '/api/projects') result = { projects: [{ id: 'p1', name: 'First project' }, { id: 'p2', name: 'Second project' }] };
    else if (url === '/api/gateways' && method === 'GET') result = { instances, health };
    else if (url.startsWith('/api/gateways/targets/')) result = { agents: [{ id: 'a1', name: 'Writer' }], teams: [{ id: 't1', name: 'Editors' }] };
    else if (url.endsWith('/discord-recovery')) {
      if (failRecovery) return new Response(JSON.stringify({ error: 'This Discord gap changed. Reload and review it again.' }), { status: 409 });
      if (method === 'POST') recovery = { gap: null }; result = recovery;
    }
    else if (url.endsWith('/inbox')) result = { events: [] };
    else if (url.endsWith('/credentials')) {
      if (failToken) return new Response(JSON.stringify({ error: 'Could not store token.' }), { status: 500 });
      const instance = instances.find((item) => url.includes(item.id))!; if (method === 'POST') { for (const key of ['botToken', 'appToken']) if (Object.hasOwn(body, key)) { if (body[key] === null) delete instance.credentials[key]; else instance.credentials[key] = Boolean(body[key]); } } else instance.credentials = { botToken: Boolean(body.botToken) };
      result = instance.credentials;
    } else if (method === 'POST' && url === '/api/gateways') {
      const instance = { ...body, id: `g${instances.length + 1}`, createdAt: 1, updatedAt: 1, routeGeneration: 1, credentials: {} } as unknown as typeof instances[number]; instances.push(instance); result = instance;
    } else if (method === 'PUT') {
      const index = instances.findIndex((item) => url === `/api/gateways/${item.id}`);
      if (index >= 0) { instances[index] = { ...instances[index], ...body }; result = instances[index]; }
    }
    return new Response(JSON.stringify(result));
  });
});
afterEach(() => { act(() => unmount?.()); vi.unstubAllGlobals(); });
async function open() { await act(async () => { unmount = mountReact(host, <GatewaysTab />).unmount; }); await settle(); }
async function create() {
  await act(async () => button('Add Telegram instance').click()); await settle();
  await type('Instance name', 'Telegram work'); await type('Bot account ID', '12345');
  await type('Allowed user IDs', '123\n456'); await type('Bot token', '12345:private-token');
}

it('creates a paused instance and stores its token separately before enabling it', async () => {
  await open(); expect(host.textContent).toContain('No gateway instances yet'); await create();
  await act(async () => button('Save instance').click()); await settle();
  const writes = requests.filter((item) => item.method !== 'GET');
  expect(writes.map((item) => item.url)).toEqual(['/api/gateways', '/api/gateways/g1/credentials']);
  expect(writes[0].body).toMatchObject({ enabled: false, senderPolicy: { allowedUserIds: ['123', '456'] }, target: { kind: 'brain' } });
  expect(writes[0].body).not.toHaveProperty('botToken');
  expect(host.textContent).not.toContain('private-token');
  await act(async () => button('Enable').click()); await settle();
  expect(requests.some((item) => item.url === '/api/gateways/g1' && item.method === 'PUT' && item.body.enabled === true)).toBe(true);
});

it('retries token failure against the same saved instance and keeps draft values', async () => {
  await open(); await create(); failToken = true;
  await act(async () => button('Save instance').click()); await settle();
  expect(host.textContent).toContain('saved paused'); expect(input('Instance name').value).toBe('Telegram work');
  expect(input('Bot account ID').disabled).toBe(true); failToken = false;
  await act(async () => button('Save instance').click()); await settle();
  expect(requests.filter((item) => item.url === '/api/gateways' && item.method === 'POST')).toHaveLength(1);
  expect(instances).toHaveLength(1);
});

it('keeps multiple instances separate and opens an instance deep link without displaying its token', async () => {
  await open(); await create(); await act(async () => button('Save instance').click()); await settle();
  instances.push({ ...instances[0], id: 'g2', name: 'Second bot', accountId: '67890' });
  act(() => unmount()); location.hash = '#/settings?tab=gateways&instance=g2'; await open();
  expect(input('Instance name').value).toBe('Second bot'); expect(input('Bot token').value).toBe('');
  expect(host.textContent).toContain('Telegram work');
  await type('Instance name', 'Second bot renamed');
  await act(async () => button('Save instance').click()); await settle();
  expect(instances[0].name).toBe('Telegram work'); expect(instances[1].name).toBe('Second bot renamed');
});

it('loads destinations for a different project and saves the explicitly chosen team', async () => {
  await open(); await create();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Gateway project"]')!.click()); await settle();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Second project'))!.click()); await settle();
  expect(requests.some((item) => item.url === '/api/gateways/targets/p2')).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Gateway destination"]')!.click()); await settle();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Editors'))!.click()); await settle();
  await act(async () => button('Save instance').click()); await settle();
  expect(instances[0]).toMatchObject({ projectId: 'p2', target: { kind: 'team', id: 't1' } });
  expect(requests.some((item) => item.url.includes('/projects/') && item.method !== 'GET')).toBe(false);
});

it('pauses an enabled instance before removing its saved token and does not re-enable it', async () => {
  await open(); await create(); await act(async () => button('Save instance').click()); await settle();
  instances[0].enabled = true;
  act(() => unmount()); await open();
  await act(async () => button('Edit').click()); await settle();
  await act(async () => button('Remove saved token').click()); await settle(); expect(input('Bot token').disabled).toBe(true);
  requests = [];
  await act(async () => button('Save instance').click()); await settle();
  const writes = requests.filter((item) => item.method === 'PUT');
  expect(writes.map((item) => item.url)).toEqual(['/api/gateways/g1', '/api/gateways/g1/credentials']);
  expect(writes[0].body.enabled).toBe(false); expect(writes[1].body).toEqual({});
  expect(instances[0].enabled).toBe(false);
});

it('shows a loading failure and offers a working retry without an empty success state', async () => {
  const working = globalThis.fetch;
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Storage unavailable.' }), { status: 503 }));
  await open(); expect(host.textContent).toContain('Storage unavailable.');
  expect(host.textContent).not.toContain('No gateway instances yet');
  vi.stubGlobal('fetch', working);
  await act(async () => button('Reload').click()); await settle();
  expect(host.textContent).toContain('No gateway instances yet'); expect(button('Add Telegram instance').disabled).toBe(false);
});

it('finishes an authorized save after navigation without changing the new page URL', async () => {
  await open(); await create(); const working = globalThis.fetch;
  let finish: (() => void) | undefined;
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    if (url === '/api/gateways' && init.method === 'POST') return new Promise<Response>((resolve) => { finish = () => resolve(working(url, init)); });
    return working(url, init);
  });
  await act(async () => button('Save instance').click());
  expect(finish).toBeDefined(); act(() => unmount()); location.hash = '#/station';
  await act(async () => finish!()); await settle();
  expect(instances[0].credentials.botToken).toBe(true);
  expect(location.hash).toBe('#/station');
});

it('opens a per-instance inbox deep link and reports a deleted instance clearly', async () => {
  await open(); await create(); await act(async () => button('Save instance').click()); await settle();
  act(() => unmount()); location.hash = '#/settings?tab=gateways&inbox=g1'; await open();
  expect(host.textContent).toContain('Inbox · Telegram work'); expect(host.textContent).toContain('No saved messages');
  expect(host.querySelector('[aria-label="Instance name"]')).toBeNull();
  act(() => unmount()); location.hash = '#/settings?tab=gateways&inbox=deleted'; await open();
  expect(host.textContent).toContain('This gateway is no longer available');
  expect(requests.some((item) => item.url === '/api/gateways/deleted/inbox')).toBe(false);
});

async function createSlack() {
  await act(async () => button('Add Slack instance').click()); await settle();
  await type('Instance name', 'Slack work'); await type('Workspace ID', 'TWORK');
  await type('Bot token', 'xoxb-private-bot'); await type('App token', 'xapp-private-app');
}
it('creates a paused Slack instance with an optional sender list and separate required tokens', async () => {
  await open(); await createSlack(); expect(host.textContent).toContain('Empty allows local workspace users'); expect(host.textContent).toContain('Socket Mode');
  await type('Allowed channels and threads', 'CWORK\nCOTHER/1700000000.000001');
  await act(async () => button('Save instance').click()); await settle();
  const writes = requests.filter((item) => item.method !== 'GET');
  expect(writes[0].body).toMatchObject({ platform: 'slack', accountId: 'TWORK', enabled: false, senderPolicy: { platform: 'slack', allowedUserIds: [] }, scope: { conversationIds: ['CWORK', 'COTHER/1700000000.000001'] } });
  expect(writes[0].body).not.toHaveProperty('botToken'); expect(writes[0].body).not.toHaveProperty('appToken');
  expect(writes[1]).toEqual({ url: '/api/gateways/g1/credentials', method: 'POST', body: { botToken: 'xoxb-private-bot', appToken: 'xapp-private-app' } });
  expect(host.textContent).not.toContain('private-'); expect(button('Enable').disabled).toBe(false);
});

it('preserves the other Slack token when updating or removing only one saved token', async () => {
  await open(); await createSlack(); await act(async () => button('Save instance').click()); await settle();
  await act(async () => button('Edit').click()); await settle(); expect(input('App token').value).toBe(''); expect(input('Bot token').value).toBe('');
  await type('App token', 'xapp-replacement'); await act(async () => button('Save instance').click()); await settle();
  expect(requests.filter((item) => item.url.endsWith('/credentials')).at(-1)?.body).toEqual({ appToken: 'xapp-replacement' });
  expect(instances[0].credentials.botToken).toBe(true);
  await act(async () => button('Edit').click()); await settle(); await act(async () => button('Remove saved app token').click());
  await act(async () => button('Save instance').click()); await settle(); expect(instances[0].credentials.botToken).toBe(true); expect(button('Enable').disabled).toBe(true);
});

it('opens a Slack setup deep link with independent fields and keeps token drafts after a failed save', async () => {
  await open(); await createSlack(); failToken = true; await act(async () => button('Save instance').click()); await settle();
  expect(input('App token').value).toBe('xapp-private-app'); expect(input('Workspace ID').disabled).toBe(true); failToken = false;
  await act(async () => button('Save instance').click()); await settle(); act(() => unmount()); location.hash = '#/settings?tab=gateways&instance=g1'; await open();
  expect(input('Workspace ID').value).toBe('TWORK'); expect(input('Allowed user IDs').value).toBe(''); expect(input('App token').value).toBe('');
  expect(host.textContent).toContain('Edit Slack work'); expect(instances).toHaveLength(1);
});

async function createDiscord() {
  await act(async () => button('Add Discord instance').click()); await settle();
  await type('Instance name', 'Discord work'); await type('Bot account ID', '100000000000000001'); await type('Bot token', 'private-discord-token');
}
it('creates a paused Discord bot with explicit servers/channels, an optional user guard and a separate secret', async () => {
  await open(); await createDiscord(); expect(host.textContent).toContain('Empty allows any human'); expect(host.textContent).toContain('Message content intent');
  expect(host.querySelector('[aria-label="App token"]')).toBeNull(); await type('Allowed servers', '200000000000000001'); await type('Allowed channels and threads', '300000000000000001');
  await act(async () => button('Save instance').click()); await settle();
  expect(instances[0]).toMatchObject({ platform: 'discord', enabled: false, accountId: '100000000000000001', senderPolicy: { platform: 'discord', allowedUserIds: [] },
    scope: { guildIds: ['200000000000000001'], conversationIds: ['300000000000000001'] } });
  expect(requests.filter((item) => item.url.endsWith('/credentials')).at(-1)?.body).toEqual({ botToken: 'private-discord-token' });
  expect(host.textContent).not.toContain('private-discord-token'); expect(button('Enable').disabled).toBe(false);
  await act(async () => button('Enable').click()); await settle(); expect(instances[0].enabled).toBe(true);
});

it('keeps Discord instance drafts and deep links separate without revealing stored credentials', async () => {
  await open(); await createDiscord(); await type('Allowed user IDs', '400000000000000001'); await act(async () => button('Save instance').click()); await settle();
  instances.push({ ...instances[0], id: 'g2', name: 'Other Discord', accountId: '100000000000000002', target: { kind: 'agent', id: 'a1' } });
  act(() => unmount()); location.hash = '#/settings?tab=gateways&instance=g2'; await open();
  expect(input('Bot token').value).toBe(''); expect(input('Bot account ID').value).toBe('100000000000000002'); expect(input('Bot account ID').disabled).toBe(true);
  expect(input('Allowed user IDs').value).toBe('400000000000000001'); await type('Instance name', 'Other bot renamed');
  await act(async () => button('Save instance').click()); await settle(); expect(instances[0].name).toBe('Discord work'); expect(instances[1].target).toEqual({ kind: 'agent', id: 'a1' });
});

it('pauses a lost-session instance, explains missed messages and requires confirmation before allowing a fresh session', async () => {
  await open(); await createDiscord(); await act(async () => button('Save instance').click()); await settle(); instances[0].enabled = true;
  health = [{ instanceId: 'g1', status: 'needs-setup', reason: 'Review the recovery gap.', recoveryRequired: true, attempts: 1, updatedAt: 1 }];
  act(() => unmount()); await open(); await act(async () => button('Review recovery').click()); await settle();
  expect(host.textContent).toContain('missing messages will not be recovered'); expect(button('Allow new session')).toBeUndefined();
  await act(async () => button('Pause instance').click()); await settle(); expect(instances[0].enabled).toBe(false);
  await act(async () => button('Allow new session').click()); await settle();
  expect(requests.filter((item) => item.url.endsWith('/discord-recovery') && item.method === 'POST')).toHaveLength(0);
  await act(async () => button('Allow new session', document.querySelector('[role="dialog"]')!).click()); await settle();
  expect(requests.filter((item) => item.url.endsWith('/discord-recovery') && item.method === 'POST').at(-1)?.body).toEqual({ revision: 'a'.repeat(64), acknowledgeGap: true });
  expect(instances[0].enabled).toBe(false); expect(host.textContent).toContain('No recovery gap is waiting'); expect(button('Allow new session')).toBeUndefined();
});

it('shows stale recovery failures and offers a reload before another review', async () => {
  await open(); await createDiscord(); await act(async () => button('Save instance').click()); await settle(); failRecovery = true;
  await act(async () => button('Review recovery').click()); await settle(); expect(host.textContent).toContain('recovery record could not load'); expect(button('Allow new session')).toBeUndefined();
  failRecovery = false; await act(async () => button('Reload recovery').click()); await settle(); expect(button('Allow new session')).toBeDefined();
  await act(async () => button('Close recovery').click()); await settle(); expect(button('Enable').disabled).toBe(false);
});
