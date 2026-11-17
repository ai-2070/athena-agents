// The scene look in the Station (web/scene/host.ts): what a scene is sent, which version is shown, and how the
// host reads (and ignores) what a sandboxed scene says, against a stand-in server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseVersion, createSceneHost, sceneStateFrom } from '../../web/scene/host.ts';
import type { SceneSource } from '../../web/scene/host.ts';
import type { Agent, SceneVersion, SceneVersions, TeamListing } from '../../shared/types.ts';

const agent = (id: string, over: Partial<Agent> = {}) =>
  ({ id, name: id.toUpperCase(), emoji: '🦊', color: '#3366aa', engine: 'claude', ...over }) as Agent;
const team = (id: string, members: string[], over: Partial<TeamListing> = {}) =>
  ({ id, name: `Team ${id}`, description: '', members, lead: members[0] ?? null, ...over }) as TeamListing;
const source = (over: Partial<SceneSource> = {}): SceneSource => ({
  project: { id: 'p1', name: 'Launch' },
  agents: [agent('a1'), agent('a2'), agent('a3', { color: 'red' }), agent('brain')],
  teams: [team('t1', ['a1', 'a2'], { color: '#112233', mark: '🚀' }), team('t2', ['a2'], { color: 'not a colour' })],
  teamState: { t1: { working: ['a1'], queued: ['a2'] } },
  approvals: [],
  questions: [],
  runs: [],
  now: () => 'Reading files',
  teamColor: (i) => `#00000${i}`,
  ...over,
});

describe('what a scene is sent', () => {
  it('is the map: agents with their status and teams, no Brain among the agents', () => {
    const s = sceneStateFrom(
      source({
        runs: [{ agentId: 'a1' }, { agentId: 'brain' }] as SceneSource['runs'],
        approvals: [{ agentId: 'a2' }] as SceneSource['approvals'],
      }),
    );
    expect(s.project).toEqual({ id: 'p1', name: 'Launch' });
    expect(s.brain.status).toBe('thinking');
    expect(s.agents.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    expect(s.agents[0]).toMatchObject({ status: 'working', now: 'Reading files', teams: ['t1'] });
    expect(s.agents[1]).toMatchObject({ status: 'needs', now: 'Waiting for your OK', teams: ['t1', 't2'] });
    expect(s.agents[2]).toMatchObject({ status: 'idle', now: '', color: '#888888' });
    expect(s.teams[0]).toMatchObject({ color: '#112233', emoji: '🚀', working: ['a1'], queued: ['a2'], lead: 'a1' });
    expect(s.teams[1].color).toBe('#000001');
    expect(s.needsYou).toBe(1);
  });
});

const version = (id: string, over: Partial<SceneVersion> = {}): SceneVersion => ({
  id,
  at: 1,
  by: { kind: 'outside' },
  files: { 'index.html': { hash: 'h', size: 1 } },
  ...over,
});
const overview = (versions: SceneVersion[], over: Partial<SceneVersions> = {}): SceneVersions => ({
  versions,
  newest: versions[0]?.id ?? null,
  newestGood: versions.find((v) => v.loads === 'ok')?.id ?? null,
  present: true,
  problem: null,
  ...over,
});

describe('which version the Station shows', () => {
  it('the newest, unless it does not load; then the newest that does, or the starter', () => {
    expect(chooseVersion(overview([]))).toEqual({ version: 'starter', bar: 'none' });
    expect(chooseVersion(overview([version('v2'), version('v1', { loads: 'ok' })]))).toEqual({
      version: 'v2',
      bar: 'none',
    });
    expect(chooseVersion(overview([version('v2', { loads: 'broken' }), version('v1', { loads: 'ok' })]))).toEqual({
      version: 'v1',
      bar: 'broken',
    });
    expect(chooseVersion(overview([version('v1', { loads: 'broken' })]))).toEqual({
      version: 'starter',
      bar: 'never-loaded',
    });
    expect(chooseVersion(overview([version('v2', { loads: 'broken' })]), 'v2')).toEqual({
      version: 'v2',
      bar: 'forced',
    });
    // the folder was removed: the starter, the versions are still there
    expect(chooseVersion(overview([version('v1', { loads: 'ok' })], { present: false })).version).toBe('starter');
  });
});

describe('the scene host', () => {
  let calls: { url: string; body: unknown }[];
  let versions: SceneVersions;
  beforeEach(() => {
    calls = [];
    versions = overview([version('v1')]);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (url === '/api/scene/open') return json({ ...versions, base: '/scene/tok' });
      if (url.startsWith('/api/scene/versions')) return json(versions);
      if (url === '/api/scene/loaded') return json({ ok: true });
      return new Response('{}', { status: 404 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // (happy-dom gives iframes no window: each gets a stand-in that records what the host posts to it)
  const posted = new Map<HTMLIFrameElement, unknown[]>();
  const windowOf = (f: HTMLIFrameElement): Window => {
    if (!f.contentWindow) {
      const got: unknown[] = [];
      posted.set(f, got);
      Object.defineProperty(f, 'contentWindow', { value: { postMessage: (m: unknown) => got.push(m) } });
    }
    return f.contentWindow as Window;
  };
  const say = (f: HTMLIFrameElement | null | undefined, data: unknown) =>
    window.dispatchEvent(new MessageEvent('message', { data, source: f ? windowOf(f) : null }));

  function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const picks: unknown[] = [];
    const hovers: unknown[] = [];
    const host = createSceneHost({
      projectId: 'p1',
      container,
      state: () => sceneStateFrom(source()),
      onPick: (kind, id) => picks.push({ kind, id }),
      onMenu: () => {},
      onHover: (p) => hovers.push(p),
    });
    return { host, container, picks, hovers };
  }

  it('loads the newest version in a sandboxed iframe and shows it once it is ready', async () => {
    const { host, container } = mount();
    await settle();
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('/scene/tok/v/v1/index.html');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.classList.contains('opacity-0')).toBe(true);
    say(frame, { athena: 1, type: 'ready' });
    expect(frame?.classList.contains('opacity-0')).toBe(false);
    expect(host.shown()).toBe('v1');
    host.dispose();
  });

  it('acts on picks from the shown scene only, for things the Station has', async () => {
    const { host, container, picks } = mount();
    host.update();
    await new Promise((r) => setTimeout(r, 300));
    const frame = container.querySelector('iframe');
    say(frame, { athena: 1, type: 'ready' });
    say(frame, { athena: 1, type: 'pick', kind: 'agent', id: 'a1' });
    say(frame, { athena: 1, type: 'pick', kind: 'agent', id: 'nobody' });
    say(frame, { athena: 1, type: 'pick', kind: 'settings' });
    say(null, { athena: 1, type: 'pick', kind: 'agent', id: 'a2' });
    say(frame, { athena: 1, type: 'pick', kind: 'brain' });
    expect((posted.get(frame!) || []).map((m) => (m as { type: string }).type)).toEqual(['hello', 'state', 'select']);
    expect(picks).toEqual([
      { kind: 'agent', id: 'a1' },
      { kind: 'brain', id: undefined },
    ]);
    host.dispose();
  });

  it('reports a version that throws before it is ready as broken', async () => {
    const { host, container } = mount();
    await settle();
    const frame = container.querySelector('iframe');
    say(frame, { athena: 1, type: 'log', level: 'error', text: 'TypeError: x is undefined', uncaught: true });
    await settle();
    expect(calls.find((c) => c.url === '/api/scene/loaded')?.body).toMatchObject({
      project: 'p1',
      version: 'v1',
      loads: 'broken',
      error: 'TypeError: x is undefined',
    });
    expect(host.logs()[0]).toMatchObject({ version: 'v1', level: 'error' });
    // it never loaded: the starter instead, with the bar saying so
    await settle();
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/scene/tok/starter/index.html');
    expect(container.querySelector('.st-scene-bar')?.textContent).toMatch(/doesn't load yet/);
    host.dispose();
  });

  it('shows the newest version that loads when the newest does not', async () => {
    versions = overview([version('v2', { loads: 'broken' }), version('v1', { loads: 'ok' })]);
    const { host, container } = mount();
    await settle();
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/scene/tok/v/v1/index.html');
    expect(container.querySelector('.st-scene-bar')?.textContent).toMatch(/last version that worked/);
    host.dispose();
  });
});
