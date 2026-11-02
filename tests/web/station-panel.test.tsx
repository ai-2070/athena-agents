// The Station's side panel (React), with a stand-in for the map: what each kind of pick shows, and what
// its buttons ask the map to do.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { mountStationPanel } from '../../web/views/stationpanel.tsx';
import type { StationPanelApi } from '../../web/views/stationpanel.tsx';
import type { MapPick, TeamView } from '../../web/views/stationdata.ts';
import type { AppState, Team } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const team = (over: Partial<TeamView> = {}): TeamView => ({ id: 't1', name: 'Thumbs', members: ['a1', 'a2'], lead: 'a1', steps: [], description: 'Make thumbnails', ...over }) as TeamView;
let picked: MapPick | null;
let teams: TeamView[];
let saved: TeamView[];
let chosen: (MapPick | null)[];
let posts: { url: string; body: unknown }[];
let view: { update: () => void; unmount: () => void } | null = null;
let el: HTMLElement;

const api = (): StationPanelApi => ({
  selected: () => picked,
  teams: () => teams,
  teamState: (id) => (id === 't1' ? { working: ['a2'], queued: [] } : { working: [], queued: [] }),
  teamBusy: () => false,
  busyTeams: () => 0,
  programs: () => [],
  teamLinks: (id) => new Set(id === 't1' ? ['claude', 'x'] : []),
  now: (agentId) => (agentId === 'a2' ? { st: 'working', text: 'Blender · rendering' } : { st: 'idle', text: '' }),
  connectors: () => [],
  choose: (p) => void chosen.push(p),
  saveTeam: async (wf) => (saved.push(wf), wf as Team),
  reloadTeams: async () => {},
  spinTeam: async () => {},
  zoomToTeam: () => {},
  newTeam: () => {},
});
const open = async (p: MapPick) => {
  picked = p;
  await act(async () => void (view ? view.update() : (view = mountStationPanel(el, api()))));
  await settle();
};
const button = (text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === text)!;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><aside class="st-panel"></aside>';
  el = document.querySelector('.st-panel')!;
  picked = null;
  saved = [];
  chosen = [];
  teams = [team(), team({ id: 't2', name: 'Posts', members: [], lead: null, description: '' })];
  state.data = {
    runs: [],
    approvals: [],
    agents: [
      { id: 'a1', name: 'Scout', emoji: '🔭', engine: 'claude-code', model: 'sonnet', specialty: 'Finds ideas' },
      { id: 'a2', name: 'Maker', emoji: '🎨', engine: 'eve', model: 'm', provider: 'custom', toolGroups: ['social'] },
      { id: 'a3', name: 'Writer', emoji: '✍️', engine: 'eve', model: 'm', provider: 'custom' },
    ],
    project: { id: 'p1', name: 'Launch', brainPath: 'C:/Brain', skills: [] },
    toolGroups: [{ id: 'social', label: 'Social', description: '' }],
    mcpServers: [],
    settings: {},
    engines: { 'claude-code': { installed: true }, hermes: { installed: false }, codex: { installed: false } },
    accounts: { reddit: [], x: [{ id: 'x1' }], telegram: { configured: false }, discord: { configured: false } },
    secrets: { openrouterKey: { set: true } },
  } as unknown as AppState;
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body || '{}')) });
    if (url === '/api/routines')
      return json([
        { id: 'r1', name: 'Weekly thumbnails', text: '@Thumbs make three', enabled: true, schedule: { type: 'daily', times: ['09:00'] }, mentions: [{ kind: 'team', id: 't1', name: 'Thumbs' }], lastRun: null },
        { id: 'r2', name: 'Posts only', text: '@Posts write', enabled: true, schedule: { type: 'none' }, mentions: [{ kind: 'team', id: 't2', name: 'Posts' }] },
        { id: 'r3', name: 'Paused one', text: '@Thumbs later', enabled: false, schedule: { type: 'none' }, mentions: [{ kind: 'team', id: 't1', name: 'Thumbs' }] },
      ]);
    if (url === '/api/brain')
      return json({
        project: {},
        entries: [
          { name: 'notes', dir: true, path: 'C:/Brain/notes' },
          { name: '.DS_Store', dir: false, path: 'C:/Brain/.DS_Store' },
          { name: 'PROJECT.md', dir: false, path: 'C:/Brain/PROJECT.md' },
        ],
        files: 2,
        sizeMB: 0.1,
        git: null,
        summary: { text: 'A product launch.', from: 'PROJECT.md' },
      });
    if (url.startsWith('/api/file?')) return new Response('# Launch plan\n\nShip it.');
    return json([]);
  });
});
afterEach(() => {
  act(() => view?.unmount());
  view = null;
  vi.unstubAllGlobals();
});

describe('the Station panel', () => {
  it('draws nothing while nothing is picked', async () => {
    picked = null;
    await act(async () => void (view = mountStationPanel(el, api())));
    expect(el.textContent).toBe('');
  });

  it("a team: its goal, who's working, and making someone lead", async () => {
    await open({ type: 'branch', id: 't1' });
    expect(el.querySelector('.st-panel-title')!.textContent).toBe('Thumbs');
    expect(el.querySelector('.st-team-goal')!.textContent).toBe('Make thumbnails');
    expect(el.querySelector('.st-team-status')!.textContent).toContain('Maker working');
    const rows = [...el.querySelectorAll('.st-member')];
    expect(rows.map((r) => r.querySelector('.st-member-name')!.textContent)).toEqual(['Scoutlead', 'Maker']);
    expect(rows[1].classList.contains('working')).toBe(true);
    expect(rows[1].querySelector('.st-member-now')!.textContent).toContain('Blender · rendering');
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Make Maker lead"]')!.click());
    expect(saved.at(-1)!.lead).toBe('a2');
  });

  it('a team: adding someone and taking someone off save its members', async () => {
    await open({ type: 'branch', id: 't1' });
    // (the one agent not on the team is picked, with its badge)
    const pick = el.querySelector<HTMLElement>('[aria-label="Agent to add"]')!;
    expect(pick.textContent).toContain('Writer');
    expect(pick.querySelector('.avatar')).not.toBeNull();
    await act(async () => button('Add').click());
    expect(saved.at(-1)!.members).toEqual(['a1', 'a2', 'a3']);
    expect(saved.at(-1)!.steps!.map((s) => s.agentId)).toEqual(['a1', 'a2', 'a3']);
    // taking off the lead takes the lead too
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Take Scout off this team"]')!.click());
    expect(saved.at(-1)!.members).toEqual(['a2']);
    expect(saved.at(-1)!.lead).toBe(null);
  });

  it('a team: Setup uses the shared searchable emoji picker', async () => {
    await open({ type: 'branch', id: 't1' });
    await act(async () => [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Setup')!.click());
    await settle();
    expect(el.querySelector('.mono-fields')).not.toBeNull();
    const titles = [...el.querySelectorAll('.mono-fields > section')].map((x) => x.firstElementChild!.textContent?.trim());
    expect(titles.slice(0, 3)).toEqual(['Name and goal', 'Team skills', 'Extra access']);
    expect(titles).toContain('Symbol on the map');
    const symbol = [...el.querySelectorAll('.mono-fields > section')].find((x) => x.firstElementChild!.textContent?.trim() === 'Symbol on the map')!;
    await vi.waitFor(() => expect(symbol.querySelector('[aria-label="Choose emoji"]')).not.toBeNull());
    await act(async () => symbol.querySelector<HTMLButtonElement>('[aria-label="Choose emoji"]')!.click());
    await settle();
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search emoji"]')!;
    expect(search).not.toBeNull();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Emoji choices"] button')][0]!.click());
    expect(saved.at(-1)!.mark).toBeTruthy();
    expect(saved.at(-1)!.markFile).toBeNull();
    expect(symbol.querySelector('input[aria-label="Your own emoji"]')?.classList.contains('h-9')).toBe(true);
  });

  it('a team: the Setup tab saves the name when you leave the field', async () => {
    await open({ type: 'branch', id: 't1' });
    await act(async () => [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Setup')!.click());
    await settle();
    const name = el.querySelector<HTMLInputElement>('input[aria-label="Team name"]')!;
    expect(name.value).toBe('Thumbs');
    name.value = 'Thumbnails';
    await act(async () => void name.dispatchEvent(new Event('change')));
    expect(saved.at(-1)!.name).toBe('Thumbnails');
    // the connections it reaches, from the map
    expect([...el.querySelectorAll('.st-conn .grow')].map((x) => x.textContent)).toEqual(['Claude Code', 'X']);
  });

  it('a team: Setup lists the routines that mention it as cards, and starts a new one with it mentioned', async () => {
    await open({ type: 'branch', id: 't1' });
    await act(async () => [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Setup')!.click());
    await settle();
    const routines = [...el.querySelectorAll('.mono-fields > section')].find((x) => x.firstElementChild!.textContent?.trim() === 'Routines')!;
    const cards = [...routines.querySelectorAll<HTMLButtonElement>('button.st-conn')];
    expect(cards.map((c) => c.textContent)).toEqual(['Weekly thumbnailsDaily at 9AMNot run yet', 'Paused oneRun by handOff']);
    await act(async () => cards[0].click());
    expect(location.hash).toBe('#/routines/r1');
    await act(async () => button('New routine for this team').click());
    expect(location.hash).toBe('#/routines/new?team=t1');
  });

  it('a team with the daily message from before routines shows it, and Turn off stops it', async () => {
    teams[0] = team({ schedule: { type: 'daily', times: ['09:00'], input: 'Post the news' }, enabled: true });
    await open({ type: 'branch', id: 't1' });
    await act(async () => [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Setup')!.click());
    await settle();
    expect(el.textContent).toContain('Post the news');
    await act(async () => button('Turn off').click());
    expect(saved.at(-1)!.enabled).toBe(false);
    expect(saved.at(-1)!.schedule?.type).toBe('none');
    teams[0] = saved.at(-1)!;
    await open({ type: 'branch', id: 't1' });
    expect(el.textContent).not.toContain('Post the news');
  });

  it('an agent: its teams, adding it to another, and opening a team', async () => {
    await open({ type: 'agent', id: 'a1' });
    expect(el.querySelector('.st-panel-title')!.textContent).toBe('Scout');
    expect(el.querySelector('.st-agent-now')!.textContent).toBe('Ready');
    // (its teams are rows; its connections, buttons)
    expect([...el.querySelectorAll('div.st-conn.ok .grow')].map((x) => x.textContent)).toEqual(['Thumbs · ★ lead']);
    await act(async () => button('Add to team').click());
    await settle();
    expect(saved.at(-1)!.id).toBe('t2');
    expect(saved.at(-1)!.members).toEqual(['a1']);
    await act(async () => el.querySelector<HTMLElement>('div.st-conn.ok .grow')!.click());
    expect(chosen.at(-1)).toEqual({ type: 'branch', id: 't1' });
  });

  it('the Brain: the project, what is in its folder, and its teams', async () => {
    await open({ type: 'brain' });
    for (let i = 0; i < 20 && !el.querySelector('.st-file'); i++) await settle();
    expect(el.querySelector('.st-panel-title')!.textContent).toBe('Launch');
    expect(el.querySelector('.st-about-text')!.textContent).toBe('A product launch.');
    expect([...el.querySelectorAll('.st-file')].map((f) => f.textContent!.trim())).toEqual(['notes', '.DS_Store', 'PROJECT.md']);
    // a folder opens in Finder / Explorer, a Markdown file opens to read, anything else is just a name
    expect([...el.querySelectorAll('.st-file')].map((f) => f.tagName)).toEqual(['BUTTON', 'DIV', 'BUTTON']);
    await act(async () => el.querySelector<HTMLButtonElement>('button.st-file')!.click());
    await settle();
    expect(posts.at(-1)).toEqual({ url: '/api/brain/open', body: { path: 'C:/Brain/notes' } });
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button.st-file')].at(-1)!.click());
    await settle();
    expect(document.querySelector('.modal-head h2')!.textContent).toBe('PROJECT.md');
    expect(document.querySelector('.modal-body .md')!.textContent).toContain('Launch plan');
    // so does the file the description comes from
    document.querySelector('#modal-root')!.innerHTML = '';
    await act(async () => el.querySelector<HTMLButtonElement>('button.st-about-from')!.click());
    await settle();
    expect(document.querySelector('.modal-head h2')!.textContent).toBe('PROJECT.md');
    expect([...el.querySelectorAll('.list .title')].map((t) => t.textContent)).toEqual(['Thumbs', 'Posts']);
    await act(async () => el.querySelector<HTMLElement>('.list .list-row')!.click());
    expect(chosen.at(-1)).toEqual({ type: 'branch', id: 't1' });
  });

  it('a connection: the teams and agents that reach it', async () => {
    await open({ type: 'int', id: 'x' });
    expect(el.querySelector('.st-panel-title')!.textContent).toBe('X');
    expect(el.querySelector('.pill')!.textContent).toBe('ready');
    expect([...el.querySelectorAll('.list .grow')].map((l) => l.textContent)).toEqual(['Thumbs', 'Maker']);
  });

  it('the Bench: agents on no team', async () => {
    teams = [team({ members: ['a1'] })];
    await open({ type: 'bench' });
    expect(el.querySelector('.st-panel-title')!.textContent).toBe('2 agents not on a team');
    expect([...el.querySelectorAll('.list .title')].map((t) => t.textContent)).toEqual(['Maker', 'Writer']);
  });
});
