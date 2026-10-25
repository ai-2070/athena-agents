// Settings: everything you set up once, in tabs. General · Connections · MCP servers · Programs.
// A search box finds any setting: it switches to its tab, scrolls to it and flashes it.
// Links can do the same with #/settings?tab=general&find=OpenAI Codex
import { h, mount } from '../core.ts';
import { icon } from '../icons.ts';
import * as general from './settings.ts';
import * as connections from './connections.ts';
import * as mcp from './mcp.ts';
import * as programs from './programs.ts';
import * as look from './look.ts';
import type { ServerEvent } from '../../shared/types.ts';

/** What a tab's view module offers (the same shape as the views in app.ts). */
interface TabView {
  render(el: HTMLElement, params?: string[]): Promise<void> | void;
  unmount?(): void;
  onEvent?(ev: ServerEvent): unknown;
}
interface Tab {
  id: string;
  label: string;
  view: TabView;
}
/** One searchable setting. */
interface IndexEntry {
  tab: string;
  sub?: string;
  find: string;
  label: string;
  words: string;
}

const TABS: Tab[] = [
  { id: 'general', label: 'General & keys', view: general },
  { id: 'connections', label: 'Connections', view: connections },
  { id: 'mcp', label: 'MCP servers', view: mcp },
  { id: 'programs', label: 'Programs', view: programs },
  { id: 'look', label: 'Look', view: look },
];

// What can be found. find = text on the page to jump to; words = extra search words.
const INDEX: IndexEntry[] = [
  { tab: 'general', find: 'AI keys', label: 'AI keys', words: 'openrouter key api anthropic token' },
  { tab: 'general', find: 'OpenRouter key', label: 'OpenRouter key', words: 'api key models gpt gemini llama deepseek' },
  { tab: 'general', find: 'Claude Code', label: 'Claude Code', words: 'claude cli login version installed' },
  { tab: 'general', find: 'OpenAI Codex', label: 'OpenAI Codex', words: 'codex chatgpt gpt install sign in login' },
  { tab: 'general', find: 'Hermes', label: 'Hermes', words: 'hermes agent' },
  { tab: 'general', find: "The Brain's model", label: "The Brain's model", words: 'brain auto router haiku sonnet opus model new team new agent auto-build' },
  { tab: 'general', find: 'Defaults for new agents', label: 'Defaults for new agents', words: 'default engine model autonomy brain' },
  { tab: 'general', find: 'Autonomy', label: 'Autonomy (ask, auto, full)', words: 'permissions approval ask first auto full' },
  { tab: 'general', find: 'Limits', label: 'Limits', words: 'max tool steps cost limit usd budget' },
  { tab: 'general', find: 'Cost limit per message', label: 'Cost limit per message', words: 'usd money budget openrouter' },
  { tab: 'general', find: 'Local and custom models', label: 'Local and custom models', words: 'lm studio ollama custom openai-compatible url local' },
  { tab: 'general', find: 'LM Studio server', label: 'LM Studio', words: 'local model server' },
  { tab: 'general', find: 'Ollama server', label: 'Ollama', words: 'local model server' },
  { tab: 'general', find: 'ComfyUI address', label: 'ComfyUI address', words: 'comfy images workflows 8188 port' },
  { tab: 'general', find: 'Allowed folders', label: 'Allowed folders', words: 'files folders read write paths access' },
  { tab: 'general', find: 'About', label: 'About this dashboard', words: 'address port data folder login localhost' },
  { tab: 'connections', sub: 'accounts', find: 'X accounts', label: 'X (Twitter) accounts', words: 'x twitter connect account auto-post dm' },
  { tab: 'connections', sub: 'accounts', find: 'Your X app', label: 'X app setup', words: 'x twitter client id secret callback oauth developer' },
  { tab: 'connections', sub: 'accounts', find: 'Reddit accounts', label: 'Reddit accounts', words: 'reddit connect account auto-post subreddit' },
  { tab: 'connections', sub: 'accounts', find: 'Your Reddit app', label: 'Reddit app setup', words: 'reddit client id secret username redirect oauth' },
  { tab: 'connections', sub: 'accounts', find: 'Telegram', label: 'Telegram', words: 'telegram bot token chat id notifications' },
  { tab: 'connections', sub: 'accounts', find: 'Discord', label: 'Discord', words: 'discord webhook channel' },
  { tab: 'connections', sub: 'accounts', find: 'Everything else', label: 'Other services', words: 'gmail calendar drive notion slack linkedin youtube connectors' },
  { tab: 'connections', sub: 'outbox', find: 'Waiting for you', label: 'Outbox (posts waiting for you)', words: 'outbox approve posts drafts tweets dm pending queue' },
  { tab: 'connections', sub: 'outbox', find: 'New post', label: 'Write a new post', words: 'tweet post compose draft' },
  { tab: 'mcp', find: 'Your MCP servers', label: 'Your MCP servers', words: 'mcp servers tools add command url' },
  { tab: 'mcp', find: 'Presets', label: 'MCP presets', words: 'mcp presets install playwright github filesystem' },
  { tab: 'mcp', find: 'Found in your Claude configs', label: 'MCP servers from Claude configs', words: 'import claude desktop config mcp' },
  { tab: 'mcp', find: 'Built-in tools', label: 'Built-in tools', words: 'tools risk approval dashboard' },
  { tab: 'mcp', find: 'Share the dashboard tools', label: 'Share the dashboard tools', words: 'bridge external claude desktop mcp' },
  { tab: 'look', find: 'UI scale', label: 'UI scale', words: 'look zoom size bigger smaller text font scale display' },
  { tab: 'look', find: 'Accent colour', label: 'Accent colour', words: 'look color colour theme highlight lime' },
  { tab: 'look', find: 'Animations', label: 'Animations', words: 'look motion reduce animation effects' },
  { tab: 'programs', find: 'ComfyUI', label: 'ComfyUI', words: 'comfy images workflows' },
  { tab: 'programs', find: 'Blender', label: 'Blender', words: '3d programs apps' },
  { tab: 'programs', find: 'Premiere', label: 'Premiere Pro', words: 'video editing adobe programs' },
  { tab: 'programs', find: 'All apps', label: 'All apps (Start Menu)', words: 'programs installed apps start menu' },
  { tab: 'programs', find: 'Not found', label: 'Programs not found', words: 'missing install' },
];

let tab = 'general';
let inner: TabView | null = null;

export const title = () => 'Settings';

const norm = (s: string | null | undefined): string => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Find the element whose text best matches `text`, scroll to it and flash it. Views load async, so retry a bit.
function focusText(root: ParentNode, text: string | null, tries = 14): void {
  const want = norm(text);
  if (!want) return;
  const cands = [...root.querySelectorAll<HTMLElement>('h2, h3, .label, .title, .card-title, label, li, b, span')].filter((e) => {
    const t = norm(e.textContent);
    return t && t.length < 160 && t.includes(want);
  });
  cands.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
  const el = cands[0];
  if (!el) {
    if (tries > 0) setTimeout(() => focusText(root, text, tries - 1), 150);
    return;
  }
  const box = el.closest<HTMLElement>('.panel, .list-item, .card') || el;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('flash-find');
  void box.offsetWidth;
  box.classList.add('flash-find');
  setTimeout(() => box.classList.remove('flash-find'), 2200);
}

export async function render(el: HTMLElement): Promise<void> {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (TABS.some((t) => t.id === q.get('tab'))) tab = q.get('tab')!;
  const body = h('div');
  const search = h('input.settings-search-input', { type: 'search', placeholder: 'Search settings…', 'aria-label': 'Search settings' });
  const results = h('div.settings-search-results.hidden');
  let picked = 0;
  let hits: IndexEntry[] = [];

  const go = async (t: string, { sub, find }: { sub?: string; find?: string } = {}) => {
    tab = t;
    const hash = `#/settings?tab=${t}${sub ? `&sub=${sub}` : ''}`;
    history.replaceState(null, '', hash);
    await draw();
    if (find) focusText(body, find);
  };

  const drawResults = () => {
    const qv = norm(search.value);
    if (!qv) {
      results.classList.add('hidden');
      return;
    }
    const words = qv.split(' ');
    hits = INDEX.map((it) => {
      const hay = norm(`${it.label} ${it.find} ${it.words}`);
      if (!words.every((w) => hay.includes(w))) return null;
      return { it, score: (norm(it.label).startsWith(qv) ? 0 : norm(it.label).includes(qv) ? 1 : 2) };
    })
      .filter((x): x is { it: IndexEntry; score: number } => !!x)
      .sort((a, b) => a.score - b.score)
      .slice(0, 9)
      .map((x) => x.it);
    picked = Math.min(picked, Math.max(0, hits.length - 1));
    const tabLabel = (id: string) => TABS.find((t) => t.id === id)?.label || id;
    mount(
      results,
      hits.length
        ? hits.map((it, i) =>
            h(
              `button.settings-search-hit${i === picked ? '.on' : ''}`,
              { type: 'button', onmousedown: (e) => (e.preventDefault(), choose(it)) },
              icon('search', 14),
              h('span.grow', it.label),
              h('span.hint', tabLabel(it.tab)),
            ),
          )
        : h('button.settings-search-hit', { type: 'button', onmousedown: (e) => (e.preventDefault(), choose(null)) }, icon('search', 14), h('span.grow', `Find "${search.value.trim()}" on this tab`)),
    );
    results.classList.remove('hidden');
  };
  const choose = (it: IndexEntry | null) => {
    results.classList.add('hidden');
    if (it) go(it.tab, { sub: it.sub, find: it.find });
    else focusText(body, search.value, 0);
    search.blur();
  };
  search.addEventListener('input', () => ((picked = 0), drawResults()));
  search.addEventListener('focus', drawResults);
  search.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + Math.max(1, hits.length)) % Math.max(1, hits.length);
      drawResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(hits[picked] || null);
    } else if (e.key === 'Escape' && (search.value || !results.classList.contains('hidden'))) {
      e.preventDefault();
      search.value = '';
      results.classList.add('hidden');
    }
  });
  const searchBox = h('div.settings-search', icon('search', 15), search, results);

  const draw = async () => {
    inner?.unmount?.();
    inner = TABS.find((t) => t.id === tab)!.view;
    mount(
      el,
      h(
        'div.settings-top',
        h('div.tabs', TABS.map((t) => h(`button${tab === t.id ? '.on' : ''}`, { onclick: () => go(t.id) }, t.label))),
        searchBox,
      ),
      body,
    );
    await inner.render(body, []);
  };
  await draw();
  if (q.get('find')) focusText(body, q.get('find'));
}

export function unmount(): void {
  inner?.unmount?.();
}

export function onEvent(ev: ServerEvent): void {
  inner?.onEvent?.(ev);
}
