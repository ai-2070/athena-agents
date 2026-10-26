// Settings: everything you set up once, in tabs. General · Connections · MCP servers · Programs · Look.
// A search box finds any setting: it switches to its tab, scrolls to it and flashes it.
// Links can do the same with #/settings?tab=general&find=OpenAI Codex
// React and Base UI: the tabs, the search (an autocomplete) and every tab's page.
import { useEffect, useRef, useState } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { GeneralTab } from './settings.tsx';
import { ConnectionsTab } from './connections.tsx';
import { McpTab } from './mcp.tsx';
import { ProgramsTab } from './programs.tsx';
import { LookTab } from './look.tsx';
import { Tabs } from '../ui/controls.tsx';
import { Icon, reactPage } from '../ui/react.tsx';
import type { ComponentType } from 'react';

type TabId = 'general' | 'connections' | 'mcp' | 'programs' | 'look';
interface Tab {
  id: TabId;
  label: string;
  Page: ComponentType;
}
/** One searchable setting. */
interface IndexEntry {
  tab: TabId;
  sub?: string;
  find: string;
  label: string;
  words: string;
}

const TABS: Tab[] = [
  { id: 'general', label: 'General & keys', Page: GeneralTab },
  { id: 'connections', label: 'Connections', Page: ConnectionsTab },
  { id: 'mcp', label: 'MCP servers', Page: McpTab },
  { id: 'programs', label: 'Programs', Page: ProgramsTab },
  { id: 'look', label: 'Look', Page: LookTab },
];

// What can be found. find = text on the page to jump to; words = extra search words.
const INDEX: IndexEntry[] = [
  { tab: 'general', find: 'AI keys', label: 'AI keys', words: 'openrouter key api anthropic token' },
  { tab: 'general', find: 'OpenRouter key', label: 'OpenRouter key', words: 'api key models gpt gemini llama deepseek' },
  { tab: 'general', find: 'Claude Code', label: 'Claude Code', words: 'claude cli login version installed' },
  { tab: 'general', find: 'OpenAI Codex', label: 'OpenAI Codex', words: 'codex chatgpt gpt install sign in login' },
  { tab: 'general', find: 'Hermes', label: 'Hermes', words: 'hermes agent' },
  { tab: 'general', find: 'pi coding agent', label: 'pi coding agent', words: 'pi earendil install' },
  { tab: 'general', find: 'oh-my-pi', label: 'oh-my-pi', words: 'omp oh my pi install' },
  { tab: 'general', find: 'OpenClaw', label: 'OpenClaw', words: 'openclaw claw gateway agents install' },
  { tab: 'general', find: "The Brain's model", label: "The Brain's model", words: 'brain auto router haiku sonnet opus model new team new agent auto-build' },
  { tab: 'general', find: 'The Brain approves', label: 'The Brain approves (auto-approval)', words: 'auto approve approval permissions brain allow needs you agents teams' },
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

// kept while you move around the app, as before
let lastTab: TabId = 'general';

const norm = (s: string | null | undefined): string => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Find the element whose text best matches `text`, scroll to it and flash it. Tabs load async, so retry a bit.
export function focusText(root: ParentNode, text: string | null, tries = 14): void {
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

/** The settings that match every word typed, best first (at most 9). */
export function searchSettings(query: string): IndexEntry[] {
  const qv = norm(query);
  if (!qv) return [];
  const words = qv.split(' ');
  return INDEX.map((it) => {
    const hay = norm(`${it.label} ${it.find} ${it.words}`);
    if (!words.every((w) => hay.includes(w))) return null;
    return { it, score: norm(it.label).startsWith(qv) ? 0 : norm(it.label).includes(qv) ? 1 : 2 };
  })
    .filter((x): x is { it: IndexEntry; score: number } => !!x)
    .sort((a, b) => a.score - b.score)
    .slice(0, 9)
    .map((x) => x.it);
}

const tabLabel = (id: TabId) => TABS.find((t) => t.id === id)?.label || id;
/** What the list offers: matching settings, or (none matching) finding the text on this tab. */
type Hit = IndexEntry | { here: string };

function SettingsSearch({ onChoose }: { onChoose: (hit: Hit) => void }) {
  const [text, setText] = useState('');
  // open while there is something typed; closed after a pick, Escape or leaving the box
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const found = searchSettings(text);
  const items: Hit[] = text.trim() ? (found.length ? found : [{ here: text.trim() }]) : [];
  const choose = (hit: Hit) => {
    setOpen(false);
    onChoose(hit);
    input.current?.blur();
  };
  return (
    <Autocomplete.Root
      items={items}
      filter={null}
      value={text}
      onValueChange={(v, d) => {
        if (d.reason === 'item-press') return;
        setText(v);
        setOpen(!!v.trim());
      }}
      open={open}
      onOpenChange={(o) => setOpen(o && !!text.trim())}
      itemToStringValue={(hit: Hit) => ('here' in hit ? hit.here : hit.label)}
      autoHighlight
    >
      <div className="settings-search" ref={anchor}>
        <Icon name="search" size={15} />
        <Autocomplete.Input ref={input} className="settings-search-input" type="search" placeholder="Search settings…" aria-label="Search settings" />
      </div>
      <Autocomplete.Portal>
        <Autocomplete.Positioner anchor={anchor} align="end" sideOffset={6} className="settings-search-positioner">
          <Autocomplete.Popup className="settings-search-pop">
            <Autocomplete.List>
              {(hit: Hit) => (
                <Autocomplete.Item
                  key={'here' in hit ? '?here' : `${hit.tab}:${hit.find}`}
                  value={hit}
                  className={(s) => `settings-search-hit${s.highlighted ? ' on' : ''}`}
                  onClick={() => choose(hit)}
                >
                  <Icon name="search" size={14} />
                  {'here' in hit ? (
                    <span className="grow">{`Find "${hit.here}" on this tab`}</span>
                  ) : (
                    <>
                      <span className="grow">{hit.label}</span>
                      <span className="hint">{tabLabel(hit.tab)}</span>
                    </>
                  )}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}

function TabBody({ tab, hostRef }: { tab: Tab; hostRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={hostRef}>
      <tab.Page />
    </div>
  );
}

function SettingsPage() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const asked = q.get('tab');
  const [tab, setTab] = useState<TabId>(() => (TABS.some((t) => t.id === asked) ? (lastTab = asked as TabId) : lastTab));
  const panel = useRef<HTMLDivElement | null>(null);
  // text to find once the tab is drawn (from a link, or a search that switched tabs)
  const pendingFind = useRef<string | null>(q.get('find'));
  // bumped to draw the open tab again: it reads ?sub= only when it draws
  const [drawn, setDrawn] = useState(0);

  useEffect(() => {
    if (pendingFind.current && panel.current) focusText(panel.current, pendingFind.current);
    pendingFind.current = null;
  }, [tab, drawn]);

  const go = (t: TabId, { sub, find }: { sub?: string; find?: string } = {}) => {
    lastTab = t;
    // the tab reads ?sub= when it draws (Connections: Accounts or Outbox)
    history.replaceState(null, '', `#/settings?tab=${t}${sub ? `&sub=${sub}` : ''}`);
    if (t === tab) {
      // (a hit in a part of the open tab, which may show another part now: drawn again on it, then found)
      if (sub) {
        pendingFind.current = find || null;
        setDrawn((n) => n + 1);
      } else if (find && panel.current) focusText(panel.current, find);
      return;
    }
    pendingFind.current = find || null;
    setTab(t);
  };
  const choose = (hit: Hit) => {
    if ('here' in hit) {
      if (panel.current) focusText(panel.current, hit.here, 0);
    } else go(hit.tab, { sub: hit.sub, find: hit.find });
  };

  return (
    <Tabs
      label="Settings"
      tabs={TABS.map((t) => ({ value: t.id, label: t.label }))}
      value={tab}
      onChange={(t) => go(t)}
      rowClassName="settings-top"
      aside={<SettingsSearch onChoose={choose} />}
    >
      <TabBody key={`${tab}:${drawn}`} tab={TABS.find((t) => t.id === tab)!} hostRef={(el) => void (panel.current = el)} />
    </Tabs>
  );
}

export const title = () => 'Settings';
export const { render, unmount } = reactPage(() => <SettingsPage />);
