// Model names with versions, and one picker used everywhere a model can be switched
// (agents, the Brain chat, Settings): tabs for Claude Code, OpenRouter, Hermes and Codex.
import { h, mount, state, GET, PUT, attempt, refreshSoon, toast, navigate } from './core.ts';
import { icon, logo } from './icons.ts';
import { uiZoom } from './look.ts';
import type { Agent, BrainSetting, EngineId, EngineStatus } from '../shared/types.ts';
import type { Child } from './core.ts';

/** What modelInfo() needs: an agent, or the Brain dressed up as one (brainAsAgent). */
export interface ModelTarget {
  engine: EngineId;
  model?: string;
  provider?: string;
  claudeAuth?: string;
  hermesProfile?: string;
}
/** What the picker hands to apply(): the new engine and model (and provider for API models). */
export interface ModelPatch {
  engine: EngineId;
  model?: string;
  provider?: string;
}
export interface ModelInfo {
  name: string;
  short: string;
  latest: boolean;
  brand: string | null;
  where: string;
}
/** One entry of GET /api/models?engine=openai. */
export interface ModelListing {
  id: string;
  name?: string;
  context?: number | null;
  tools?: boolean;
  price?: { in: number; out: number } | null;
}
interface ModelTab {
  engine: EngineId;
  label: string;
  brand: string | null;
  glyph?: string;
}

// What Claude Code's short names point to today.
const CLAUDE = [
  { id: 'claude-opus-5-5', alias: 'opus', family: 'Opus', version: '5.5', note: 'most capable' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', family: 'Sonnet', version: '5.5', note: 'fast and smart' },
  { id: 'claude-haiku-5-5', alias: 'haiku', family: 'Haiku', version: '5.5', note: 'fastest, cheapest' },
  { id: 'claude-fable-5-1', alias: 'fable', family: 'Fable', version: '5.1', note: 'creative writing' },
];
const OPENROUTER_PICKS = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'];
const CODEX_PICKS = [{ id: 'gpt-6-astra', note: 'OpenAI flagship' }];

const TABS: ModelTab[] = [
  { engine: 'claude-code', label: 'Claude', brand: 'claude' },
  { engine: 'openai', label: 'OpenRouter', brand: null, glyph: '◇' },
  { engine: 'hermes', label: 'Hermes', brand: null, glyph: '☤' },
  { engine: 'codex', label: 'Codex', brand: 'openai' },
];

// { name: "Claude Sonnet 5.5", short: "Sonnet 5.5", latest: true/false, brand: "claude" | null, where: "Claude Code · Claude login" }
export function modelInfo(a: ModelTarget): ModelInfo {
  const m = String(a.model || '');
  if (a.engine === 'claude-code') {
    const key = m.replace(/^anthropic\//, '').replace(/\./g, '-').toLowerCase() || 'sonnet';
    const c = CLAUDE.find((x) => x.alias === key || x.id === key || key.startsWith(x.id));
    const auth = ({ login: 'Claude login', anthropic: 'Anthropic API key', openrouter: 'OpenRouter' } as Record<string, string | undefined>)[a.claudeAuth || 'login'];
    if (c) return { name: `Claude ${c.family} ${c.version}`, short: `${c.family} ${c.version}`, latest: key === c.alias, brand: 'claude', where: `Claude Code · ${auth}` };
    return { name: m, short: m.split('/').pop()!, latest: false, brand: 'claude', where: `Claude Code · ${auth}` };
  }
  if (a.engine === 'codex') return { name: m || 'Codex default model', short: m || 'Codex', latest: !m, brand: 'openai', where: 'OpenAI Codex · ChatGPT login' };
  if (a.engine === 'hermes') return { name: m || `Hermes profile "${a.hermesProfile || 'default'}"`, short: m ? m.split('/').pop()! : 'Hermes', latest: false, brand: null, where: `Hermes · ${a.hermesProfile || 'default'}` };
  const where = ({ lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom server' } as Record<string, string | undefined>)[a.provider as string] || 'OpenRouter';
  const id = m.split('/').pop() || 'model';
  const c = CLAUDE.find((x) => id.replace(/\./g, '-').startsWith(x.id));
  return { name: c ? `Claude ${c.family} ${c.version}` : id, short: c ? `${c.family} ${c.version}` : id, latest: false, brand: /claude|anthropic/.test(m) ? 'claude' : /llama|ollama/.test(m) ? 'ollama' : 'openrouter', where };
}

const chipIcon = (mi: ModelInfo, engine: string): SVGSVGElement | HTMLSpanElement => (mi.brand && logo(mi.brand, 13)) || (engine === 'hermes' ? h('span.model-glyph', '☤') : icon('cpu', 13));

// A chip showing an agent's model; click it to switch (model or what it runs on).
export function modelChip(agent: Agent, { onChange, compact = false }: { onChange?: (agent: Agent) => void; compact?: boolean } = {}): HTMLButtonElement {
  const chip = h('button.model-chip', { type: 'button', title: 'Switch model' });
  const draw = () => {
    const mi = modelInfo(agent);
    mount(chip, chipIcon(mi, agent.engine), h('span', mi.short), mi.latest && !compact ? h('span.model-latest', 'latest') : null, icon('chevron-down', 12));
  };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(chip, agent, async (patch) => {
      const r = await attempt(() => PUT<Agent>(`/agents/${agent.id}`, patch));
      if (!r) return;
      Object.assign(agent, patch);
      draw();
      refreshSoon(0);
      toast(`${agent.name} now uses ${modelInfo(agent).name}`);
      onChange?.(agent);
    }, { title: agent.name, local: true });
  });
  draw();
  return chip;
}

// ---------- the Brain's own model ----------
// settings.brain = { provider: 'claude' | 'openrouter' | 'hermes' | 'codex', model }
const BRAIN_ENGINE: Record<string, EngineId | undefined> = { claude: 'claude-code', openrouter: 'openai', hermes: 'hermes', codex: 'codex' };
const BRAIN_PROVIDER: Record<string, BrainSetting['provider'] | undefined> = { 'claude-code': 'claude', openai: 'openrouter', hermes: 'hermes', codex: 'codex' };
export function brainAsAgent(b: { provider?: string; model?: string } | null | undefined = state.data?.settings?.brain): ModelTarget & { model: string; provider: string } {
  const p = b?.provider || 'claude';
  return { engine: BRAIN_ENGINE[p] || 'claude-code', model: b?.model ?? 'haiku', provider: 'openrouter' };
}
export function brainModelChip({ onChange, prefix = 'Brain · ' }: { onChange?: (brain: BrainSetting) => void; prefix?: string } = {}): HTMLButtonElement {
  const chip = h('button.model-chip', { type: 'button', title: "The Brain's model: answers about the project, builds teams and agents, hands out work" });
  const draw = () => {
    const a = brainAsAgent();
    const mi = modelInfo(a);
    mount(chip, chipIcon(mi, a.engine), h('span', `${prefix}${mi.short}`), icon('chevron-down', 12));
  };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(chip, brainAsAgent(), async (patch) => {
      const brain: BrainSetting = { provider: BRAIN_PROVIDER[patch.engine] || 'claude', model: patch.model ?? '' };
      const r = await attempt(() => PUT('/settings', { brain }));
      if (!r) return;
      if (state.data?.settings) state.data.settings.brain = brain;
      draw();
      refreshSoon(0);
      toast(`The Brain now thinks with ${modelInfo(brainAsAgent(brain)).name}`);
      onChange?.(brain);
    }, { title: "The Brain's model", local: false });
  });
  draw();
  return chip;
}

// ---------- the picker ----------
// cur: { engine, model, provider }. apply(patch) gets { engine, model, provider? }.
export function openModelPicker(anchor: Element, cur: ModelTarget, apply: (patch: ModelPatch) => unknown, { title = 'Model', local = true }: { title?: string; local?: boolean } = {}): void {
  document.querySelector('.model-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h('div.st-menu.model-menu');
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => !menu.contains(e.target as Node | null) && close();
  let tab: EngineId = TABS.some((t) => t.engine === cur.engine) ? cur.engine : 'claude-code';
  const body = h('div.model-body');
  const pick = (patch: ModelPatch) => (close(), apply(patch));
  const row = (label: string, sub: string | null, active: boolean, patch: ModelPatch, brand: string | null = null) =>
    h(`button.st-menu-item${active ? '.on' : ''}`, { onclick: () => pick(patch) }, active ? icon('check', 15) : (brand && logo(brand, 14)) || icon('cpu', 15), h('span.grow', label, sub ? h('span.model-sub', sub) : null));
  const free = (placeholder: string, toPatch: (model: string) => ModelPatch) => {
    const input = h('input.model-search', { placeholder });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.trim() && pick(toPatch(input.value.trim())));
    return input;
  };
  const missing = (text: string, settingsFind: string) =>
    h('div.model-missing', icon('triangle-alert', 14), h('span.grow', text), h('button.btn.tiny', { onclick: () => (close(), navigate(`#/settings?tab=general&find=${encodeURIComponent(settingsFind)}`)) }, 'Set up'));
  const same = (engine: EngineId, model: string) => cur.engine === engine && String(cur.model || '') === model;

  const drawBody = () => {
    const eng: Partial<EngineStatus> = state.data?.engines || {};
    const items: Child[] = [];
    if (tab === 'claude-code') {
      if (eng['claude-code'] && !eng['claude-code'].installed) items.push(missing('Claude Code is not installed on this PC.', 'Claude Code'));
      items.push(h('div.st-menu-head', 'Always the newest'));
      for (const c of CLAUDE) items.push(row(`${c.family} (latest)`, `now ${c.version} · ${c.note}`, same('claude-code', c.alias), { engine: 'claude-code', model: c.alias }, 'claude'));
      items.push(h('div.st-menu-head', 'Pinned version'));
      for (const c of CLAUDE) items.push(row(`${c.family} ${c.version}`, c.id, same('claude-code', c.id), { engine: 'claude-code', model: c.id }, 'claude'));
    } else if (tab === 'openai') {
      const hasKey = !!state.data?.secrets?.openrouterKey?.set;
      if (!hasKey) items.push(missing('Add your OpenRouter key first.', 'OpenRouter key'));
      const search = h('input.model-search', { placeholder: 'Search 300+ models (gpt, gemini, llama, deepseek…)' });
      const list = h('div.model-list');
      let all: ModelListing[] = [];
      const fill = () => {
        const q = search.value.toLowerCase();
        const pool: ModelListing[] = all.length ? all : OPENROUTER_PICKS.map((id) => ({ id, name: id }));
        const shown = (q ? pool.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : pool.filter((m) => OPENROUTER_PICKS.includes(m.id) || m.id === cur.model).concat(pool.filter((m) => !OPENROUTER_PICKS.includes(m.id)).slice(0, 25))).slice(0, 60);
        mount(list, shown.map((m) => row(m.name || m.id, m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : m.id, cur.engine === 'openai' && (cur.provider || 'openrouter') === 'openrouter' && m.id === cur.model, { engine: 'openai', provider: 'openrouter', model: m.id }, /claude|anthropic/.test(m.id) ? 'claude' : null)));
      };
      search.addEventListener('input', fill);
      search.addEventListener('keydown', (e) => e.key === 'Enter' && search.value.trim() && pick({ engine: 'openai', provider: 'openrouter', model: search.value.trim() }));
      items.push(h('div.st-menu-head', 'OpenRouter'), search, list);
      if (hasKey)
        GET<ModelListing[]>('/models?engine=openai&provider=openrouter')
          .then((ms) => {
            all = ms;
            fill();
          })
          .catch(() => {});
      fill();
      if (local) {
        items.push(h('div.st-menu-head', 'On this PC'));
        for (const [p, label] of [['lmstudio', 'LM Studio'], ['ollama', 'Ollama'], ['custom', 'Custom server']])
          items.push(row(label, cur.engine === 'openai' && cur.provider === p ? cur.model || 'its loaded model' : 'its loaded model', cur.engine === 'openai' && cur.provider === p, { engine: 'openai', provider: p, model: cur.engine === 'openai' && cur.provider === p ? cur.model : '' }, p === 'ollama' ? 'ollama' : null));
      }
      setTimeout(() => search.focus(), 30);
    } else if (tab === 'hermes') {
      if (eng.hermes && !eng.hermes.installed) items.push(missing('Hermes is not installed on this PC.', 'Hermes'));
      items.push(h('div.st-menu-head', 'Hermes'), row("The profile's own model", 'whatever your Hermes profile uses', same('hermes', ''), { engine: 'hermes', model: '' }));
      for (const id of OPENROUTER_PICKS.slice(1)) items.push(row(id.split('/').pop()!, id, same('hermes', id), { engine: 'hermes', model: id }, 'claude'));
      items.push(free('or type a model id and press Enter', (m) => ({ engine: 'hermes', model: m })));
    } else {
      const cx: Partial<EngineStatus['codex']> = eng.codex || {};
      if (!cx.installed) items.push(missing('Codex is not installed yet.', 'OpenAI Codex'));
      else if (!cx.loggedIn) items.push(missing('Codex is installed but not signed in.', 'OpenAI Codex'));
      items.push(h('div.st-menu-head', 'OpenAI Codex · your ChatGPT login'), row("Codex's default model", 'whatever Codex picks', same('codex', ''), { engine: 'codex', model: '' }, 'openai'));
      for (const c of CODEX_PICKS) items.push(row(c.id, c.note, same('codex', c.id), { engine: 'codex', model: c.id }, 'openai'));
      items.push(free('or type a model id and press Enter', (m) => ({ engine: 'codex', model: m })));
    }
    mount(body, items);
  };

  const tabs = h('div.model-tabs');
  const drawTabs = (): HTMLDivElement =>
    mount(
      tabs,
      TABS.map((t) =>
        h(
          `button.model-tab${tab === t.engine ? '.on' : ''}${cur.engine === t.engine ? '.cur' : ''}`,
          { type: 'button', title: cur.engine === t.engine ? `${t.label} (in use)` : t.label, onclick: (e) => (e.stopPropagation(), (tab = t.engine), drawTabs(), drawBody()) },
          (t.brand && logo(t.brand, 13)) || h('span.model-glyph', t.glyph || '•'),
          h('span', t.label),
        ),
      ),
    );
  drawTabs();
  drawBody();
  mount(menu, h('div.st-menu-head', title), tabs, body);
  document.body.append(menu);
  const z = uiZoom();
  const W = window.innerWidth / z;
  const H = window.innerHeight / z;
  const R = { left: r.left / z, top: r.top / z, bottom: r.bottom / z };
  const height = Math.min(520, menu.offsetHeight || 420);
  const below = R.bottom + 6 + height < H - 10;
  Object.assign(menu.style, { position: 'fixed', left: `${Math.max(10, Math.min(R.left, W - 330))}px`, top: `${below ? R.bottom + 6 : Math.max(10, R.top - 6 - height)}px`, transform: 'none', zIndex: 95 });
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}
