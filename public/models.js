// Model names with versions, and a picker to switch an agent's model at any moment.
import { h, mount, state, GET, PUT, attempt, refreshSoon, toast } from './core.js';
import { icon, logo } from './icons.js';

// What Claude Code's short names point to today.
const CLAUDE = [
  { id: 'claude-opus-5-5', alias: 'opus', family: 'Opus', version: '5.5', note: 'most capable' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', family: 'Sonnet', version: '5.5', note: 'fast and smart' },
  { id: 'claude-haiku-5-5', alias: 'haiku', family: 'Haiku', version: '5.5', note: 'fastest, cheapest' },
  { id: 'claude-fable-5-1', alias: 'fable', family: 'Fable', version: '5.1', note: 'creative writing' },
];
const OPENROUTER_PICKS = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'];

// { name: "Claude Sonnet 5.5", short: "Sonnet 5.5", latest: true/false, brand: "claude" | null, where: "Claude Code · Claude login" }
export function modelInfo(a) {
  const m = String(a.model || '');
  if (a.engine === 'claude-code') {
    const key = m.replace(/^anthropic\//, '').replace(/\./g, '-').toLowerCase() || 'sonnet';
    const c = CLAUDE.find((x) => x.alias === key || x.id === key || key.startsWith(x.id));
    const auth = { login: 'Claude login', anthropic: 'Anthropic API key', openrouter: 'OpenRouter' }[a.claudeAuth || 'login'];
    if (c) return { name: `Claude ${c.family} ${c.version}`, short: `${c.family} ${c.version}`, latest: key === c.alias, brand: 'claude', where: `Claude Code · ${auth}` };
    return { name: m, short: m.split('/').pop(), latest: false, brand: 'claude', where: `Claude Code · ${auth}` };
  }
  if (a.engine === 'hermes') return { name: m || `Hermes profile "${a.hermesProfile || 'default'}"`, short: m || a.hermesProfile || 'Hermes', latest: false, brand: null, where: `Hermes · ${a.hermesProfile || 'default'}` };
  const where = { lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom server' }[a.provider] || 'OpenRouter';
  const id = m.split('/').pop() || 'model';
  const c = CLAUDE.find((x) => id.replace(/\./g, '-').startsWith(x.id));
  return { name: c ? `Claude ${c.family} ${c.version}` : id, short: c ? `${c.family} ${c.version}` : id, latest: false, brand: /claude|anthropic/.test(m) ? 'claude' : /llama|ollama/.test(m) ? 'ollama' : null, where };
}

// A chip showing the current model; click it to switch.
export function modelChip(agent, { onChange, compact = false } = {}) {
  const chip = h('button.model-chip', { type: 'button', title: 'Switch model' });
  const draw = () => {
    const mi = modelInfo(agent);
    mount(chip, (mi.brand && logo(mi.brand, 13)) || icon('cpu', 13), h('span', mi.short), mi.latest && !compact ? h('span.model-latest', 'latest') : null, icon('chevron-down', 12));
  };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelMenu(chip, agent, async (patch) => {
      const r = await attempt(() => PUT(`/agents/${agent.id}`, patch));
      if (!r) return;
      Object.assign(agent, patch);
      draw();
      refreshSoon(0);
      toast(`${agent.name} now uses ${modelInfo(agent).name}`);
      onChange?.(agent);
    });
  });
  draw();
  return chip;
}

function openModelMenu(anchor, agent, apply) {
  document.querySelector('.model-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h('div.st-menu.model-menu');
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  const row = (label, sub, active, fn, brand = null) =>
    h(`button.st-menu-item${active ? '.on' : ''}`, { onclick: () => (close(), fn()) }, active ? icon('check', 15) : (brand && logo(brand, 14)) || icon('cpu', 15), h('span.grow', label, sub ? h('span.model-sub', sub) : null));
  const items = [];
  const cur = String(agent.model || '');
  if (agent.engine === 'claude-code') {
    items.push(h('div.st-menu-head', 'Claude · pinned version'));
    for (const c of CLAUDE) items.push(row(`${c.family} ${c.version}`, c.note, cur === c.id, () => apply({ model: c.id }), 'claude'));
    items.push(h('div.st-menu-sep'), h('div.st-menu-head', 'Always the newest'));
    for (const c of CLAUDE) items.push(row(`${c.family} (latest)`, `now ${c.version}`, cur === c.alias || (!cur && c.alias === 'sonnet'), () => apply({ model: c.alias }), 'claude'));
  } else if (agent.engine === 'openai') {
    const search = h('input.model-search', { placeholder: 'Search models…' });
    const list = h('div.model-list');
    let all = [];
    const fill = () => {
      const q = search.value.toLowerCase();
      const pool = all.length ? all : OPENROUTER_PICKS.map((id) => ({ id, name: id }));
      const shown = (q ? pool.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : pool.filter((m) => OPENROUTER_PICKS.includes(m.id) || m.id === cur).concat(pool.filter((m) => !OPENROUTER_PICKS.includes(m.id)).slice(0, 25))).slice(0, 60);
      mount(list, shown.map((m) => row(m.name || m.id, m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : m.id, m.id === cur, () => apply({ model: m.id }), /claude|anthropic/.test(m.id) ? 'claude' : null)));
    };
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => e.key === 'Enter' && search.value.trim() && (close(), apply({ model: search.value.trim() })));
    items.push(h('div.st-menu-head', { class: '' }, ({ lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom server' })[agent.provider] || 'OpenRouter'), search, list);
    GET(`/models?engine=openai&provider=${agent.provider || 'openrouter'}`).then((ms) => {
      all = ms;
      fill();
    }).catch(() => {});
    fill();
    setTimeout(() => search.focus(), 30);
  } else {
    items.push(h('div.st-menu-head', 'Hermes'), row("Profile's own model", agent.hermesProfile || 'default', !cur, () => apply({ model: '' })));
    const input = h('input.model-search', { placeholder: 'or type a model id and press Enter' });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.trim() && (close(), apply({ model: input.value.trim() })));
    items.push(input);
  }
  items.push(h('div.st-menu-sep'), h('div.st-menu-head', 'Runs on'));
  for (const [engine, label] of [['claude-code', 'Claude Code'], ['openai', 'API model (OpenRouter / local)'], ['hermes', 'Hermes']])
    items.push(row(label, null, agent.engine === engine, () => apply({ engine, model: engine === 'claude-code' ? 'claude-sonnet-5-5' : engine === 'openai' ? state.data.settings.defaults.openrouterModel : '' }), engine === 'claude-code' ? 'claude' : null));
  mount(menu, items);
  document.body.append(menu);
  const top = Math.min(r.bottom + 6, window.innerHeight - 20 - Math.min(480, menu.offsetHeight || 400));
  Object.assign(menu.style, { position: 'fixed', left: `${Math.min(r.left, window.innerWidth - 280)}px`, top: `${Math.max(10, top)}px`, transform: 'none', zIndex: 90 });
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}
