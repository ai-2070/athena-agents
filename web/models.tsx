// Model names with versions, and one picker used everywhere a model can be switched
// (agents, the Brain chat, Settings): tabs for your favorites, Claude Code, OpenRouter, LM Studio, Hermes, Codex, pi,
// oh-my-pi and OpenClaw,
// and how hard the model thinks (effort). The chips and the picker are React now: a chip is still the plain button
// callers pass around (React draws what is inside it), and the picker mounts against the chip it opened from.
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { state, GET, PUT, attempt, refreshSoon, toast, navigate } from './core.ts';
import { brandImage } from './brandimages.ts';
import { appIcon, appIconUrl } from './appicons.ts';
import { brandPath, logo } from './icons.ts';
import { EFFORT_NAMES, effortFor, effortLevels, isEffort } from '../shared/effort.ts';
import { defaultModelForEngine } from '../shared/modeldefaults.ts';
import { Button } from './ui/button.tsx';
import { PopoverContent, PopoverRoot } from './ui/popover.tsx';
import { DomNode, Icon } from './ui/react.tsx';
import type { Agent, ApiModelInfo, BrainSetting, Effort, EngineId, EngineStatus, FavoriteModel } from '../shared/types.ts';

/** What modelInfo() needs: an agent, or the Brain dressed up as one (brainAsAgent). */
export interface ModelTarget {
  engine: EngineId;
  model?: string;
  provider?: string;
  claudeAuth?: string;
  hermesProfile?: string;
  openclawAgent?: string;
  effort?: Effort | '';
}
/** A model in the picker: its engine and model (and provider for API models). */
export interface ModelChoice {
  engine: EngineId;
  model?: string;
  provider?: string;
}
/** What the picker hands to apply(): the model, and the effort for it ('' = the model's default). */
export interface ModelPatch extends ModelChoice {
  effort: Effort | '';
}
export interface ModelInfo {
  name: string;
  short: string;
  latest: boolean;
  brand: string | null;
  where: string;
}
/** One entry of GET /api/models (engine=openai, codex, pi…). */
export interface ModelListing extends Partial<Omit<ApiModelInfo, 'id'>> {
  id: string;
  /** Codex: what the model is for */
  description?: string;
}
/** A picker tab: an engine, Favorites, or LM Studio (API models on this PC, with a tab of their own). */
type PickerTab = EngineId | 'fav' | 'lmstudio' | 'venice';
interface ModelTab {
  engine: PickerTab;
  label: string;
  brand: string | null;
  glyph?: string;
}
/** The tab a model belongs on: LM Studio models run on the API-model engine but get their own tab. */
export const tabOf = (t: { engine: EngineId; provider?: string }): PickerTab => (t.engine === 'openai' && (t.provider === 'lmstudio' || t.provider === 'venice') ? t.provider : t.engine);

// What Claude Code's short names point to today.
const CLAUDE = [
  { id: 'claude-opus-5-5', alias: 'opus', family: 'Opus', version: '5.5', note: 'most capable' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', family: 'Sonnet', version: '5.5', note: 'fast and smart' },
  { id: 'claude-haiku-5-5', alias: 'haiku', family: 'Haiku', version: '5.5', note: 'fastest, cheapest' },
  { id: 'claude-fable-5-1', alias: 'fable', family: 'Fable', version: '5.1', note: 'creative writing' },
];
const OPENROUTER_PICKS = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'];
// shown when the server can't be reached; normally Codex's own list comes from GET /models?engine=codex
const CODEX_PICKS: ModelListing[] = [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' }];

const TABS: ModelTab[] = [
  { engine: 'claude-code', label: 'Claude', brand: 'claude' },
  { engine: 'openai', label: 'OpenRouter', brand: 'openrouter', glyph: '◇' },
  { engine: 'lmstudio', label: 'LM Studio', brand: null, glyph: 'LM' },
  { engine: 'venice', label: 'Venice', brand: null },
  { engine: 'hermes', label: 'Hermes', brand: null },
  { engine: 'codex', label: 'Codex', brand: 'openai' },
  { engine: 'pi', label: 'pi', brand: null },
  { engine: 'omp', label: 'OMP', brand: null },
  { engine: 'openclaw', label: 'OpenClaw', brand: null },
];
// The CLI engines with their own model lists (GET /models?engine=…): what an empty model means, and where to set them up.
const CLI_TABS: Partial<Record<EngineId, { name: string; own: string; find: string }>> = {
  pi: { name: 'pi', own: "pi's default model", find: 'pi coding agent' },
  omp: { name: 'oh-my-pi', own: "oh-my-pi's default model", find: 'oh-my-pi' },
  openclaw: { name: 'OpenClaw', own: "the OpenClaw agent's own model", find: 'OpenClaw' },
};
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
  if (a.engine === 'openclaw') return { name: m || `OpenClaw agent "${a.openclawAgent || 'default'}"`, short: m ? m.split('/').pop()! : 'OpenClaw', latest: false, brand: /claude|anthropic/.test(m) ? 'claude' : null, where: `OpenClaw · ${a.openclawAgent || 'default agent'}` };
  if (a.engine === 'pi' || a.engine === 'omp') {
    const label = a.engine === 'pi' ? 'pi' : 'oh-my-pi';
    return { name: m || `${label} default model`, short: m ? m.split('/').pop()! : label, latest: false, brand: /claude|anthropic/.test(m) ? 'claude' : null, where: `${label}${m.includes('/') ? ` · ${m.split('/')[0]}` : ''}` };
  }
  const where = ({ venice: 'Venice', lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom server' } as Record<string, string | undefined>)[a.provider as string] || 'OpenRouter';
  const id = m.split('/').pop() || 'model';
  const c = CLAUDE.find((x) => id.replace(/\./g, '-').startsWith(x.id));
  return { name: c ? `Claude ${c.family} ${c.version}` : id, short: c ? `${c.family} ${c.version}` : id, latest: false, brand: /claude|anthropic/.test(m) ? 'claude' : /llama|ollama/.test(m) ? 'ollama' : where === 'OpenRouter' ? 'openrouter' : null, where };
}

// the model chip; model-chip stays as a marker (the Brain chat and the Station panel style it from outside)
const CHIP = 'inline-flex items-center gap-2 whitespace-nowrap py-1.5 px-3 border border-line-2 rounded-full bg-panel text-ink font-sans text-[12.5px] font-medium leading-[normal] cursor-pointer [transition:border-color_0.18s,background-color_0.18s] hover:bg-panel-2 [&_.ico-svg]:text-dim';
// the search box over a list (the skill picker has one too)
export const SEARCH = 'model-search mt-1 mb-2 px-3 py-2 text-[13.5px]';

/** The effort a target runs at, as its engine takes it ('' = the model's default). */
export const effortOf = (a: ModelTarget): Effort | '' => a.engine === 'openai' && a.provider === 'venice' ? isEffort(a.effort) ? a.effort : '' : effortFor(a.engine, a.effort, a.provider);
/** "Claude Opus 5.5" or "Claude Opus 5.5 (high effort)" */
const withEffort = (a: ModelTarget) => {
  const e = effortOf(a);
  return `${modelInfo(a).name}${e ? ` (${EFFORT_NAMES[e].toLowerCase()} effort)` : ''}`;
};
const sameModel = (a: ModelChoice, b: ModelChoice) => a.engine === b.engine && String(a.model || '') === String(b.model || '') && (a.engine !== 'openai' || (a.provider || 'openrouter') === (b.provider || 'openrouter'));

// ---------- favorites (Settings: favoriteModels) ----------
const ENGINES: EngineId[] = ['claude-code', 'openai', 'hermes', 'codex', 'pi', 'omp', 'openclaw'];
export function favoriteModels(): FavoriteModel[] {
  const list = state.data?.settings?.favoriteModels;
  return Array.isArray(list) ? list.filter((f) => f && ENGINES.includes(f.engine) && typeof f.model === 'string') : [];
}
export const isFavorite = (m: ModelChoice) => favoriteModels().some((f) => sameModel(f, m));
/** Star or unstar a model. Saved in Settings, so every picker shows it. */
export async function toggleFavorite(m: ModelChoice): Promise<boolean> {
  const before = favoriteModels();
  const on = !before.some((f) => sameModel(f, m));
  const fav: FavoriteModel = { engine: m.engine, model: m.model || '', ...(m.engine === 'openai' ? { provider: m.provider || 'openrouter' } : {}) };
  const list = on ? [...before, fav] : before.filter((f) => !sameModel(f, m));
  if (state.data?.settings) state.data.settings.favoriteModels = list;
  const r = await attempt(() => PUT('/settings', { favoriteModels: list }));
  if (!r && state.data?.settings) state.data.settings.favoriteModels = before;
  return r ? on : !on;
}

// ---------- the chips ----------

/** A brand logo, drawn by web/icons.ts (it has no React form), or the plain mark beside it. */
function BrandMark({ brand, size, fallback }: { brand: string | null; size: number; fallback: ReactNode }) {
  if (!brand || !brandPath(brand)) return <>{fallback}</>;
  return <DomNode as="span" className="dom-contents" make={() => logo(brand, size, brand === 'openai' ? 'currentColor' : null)} deps={[brand, size]} />;
}

/** A tag saying how hard the model thinks, when it isn't its engine's default. */
function EffortTag({ effort }: { effort: Effort | '' }) {
  if (!effort) return null;
  return (
    <span className="pill-shadow font-sans text-[10.5px] font-medium leading-[15px] text-accent border border-accent-dim rounded-full px-1.5" title={`Effort: ${EFFORT_NAMES[effort]}`}>
      {EFFORT_NAMES[effort]}
    </span>
  );
}

/** What a chip shows: the model's mark, its short name, the effort, "latest" and a chevron. */
function ChipFace({ brand, engine, label, effort, latest }: { brand: string | null; engine: string; label: string; effort: Effort | ''; latest: boolean }) {
  const ownMark = !brand && brandImage(engine, 13);
  return (
    <>
      <BrandMark brand={brand} size={13} fallback={ownMark ? <DomNode as="span" className="dom-contents" make={() => ownMark} deps={[engine]} /> : <Icon name="cpu" size={13} />} />
      <span>{label}</span>
      <EffortTag effort={effort} />
      {latest ? <span className="model-latest">latest</span> : null}
      <Icon name="chevron-down" size={12} />
    </>
  );
}

/** A model chip: still the plain button callers pass around; React draws what is inside it. */
function makeChip(title: string, face: () => ReactNode): { chip: HTMLButtonElement; draw: () => void } {
  const chip = document.createElement('button');
  chip.className = `model-chip ${CHIP}`;
  chip.type = 'button';
  chip.title = title;
  const root = createRoot(chip);
  const draw = () => root.render(face());
  // (a plain render: a chip is often made while a page is drawing, and nothing reads its words back)
  draw();
  return { chip, draw };
}

// A chip showing an agent's model; click it to switch (model or what it runs on).
export function modelChip(agent: Agent, { onChange, compact = false }: { onChange?: (agent: Agent) => void; compact?: boolean } = {}): HTMLButtonElement {
  const { chip, draw } = makeChip('Switch model', () => {
    const mi = modelInfo(agent);
    return <ChipFace brand={mi.brand} engine={agent.engine} label={mi.short} effort={effortOf(agent)} latest={mi.latest && !compact} />;
  });
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(chip, agent, async (patch) => {
      const sameOne = sameModel(agent, patch);
      const r = await attempt(() => PUT<Agent>(`/agents/${agent.id}`, patch));
      if (!r) return false;
      Object.assign(agent, patch);
      flushSync(draw);
      refreshSoon(0);
      const e = effortOf(agent);
      toast(sameOne ? `${agent.name} now thinks at ${e ? `${EFFORT_NAMES[e].toLowerCase()} effort` : "the model's default effort"}` : `${agent.name} now uses ${withEffort(agent)}`);
      onChange?.(agent);
      return true;
    }, { title: agent.name, local: true });
  });
  return chip;
}

// ---------- the Brain's own model ----------
// settings.brain = { provider: 'claude' | 'openrouter' | 'hermes' | 'codex', model }
const BRAIN_ENGINE: Record<string, EngineId | undefined> = { claude: 'claude-code', openrouter: 'openai', venice: 'openai', hermes: 'hermes', codex: 'codex' };
const BRAIN_PROVIDER: Record<string, BrainSetting['provider'] | undefined> = { 'claude-code': 'claude', openai: 'openrouter', hermes: 'hermes', codex: 'codex' };
/** The engines the Brain can think with (its picker offers only these). */
const BRAIN_ENGINES: readonly EngineId[] = ['claude-code', 'openai', 'hermes', 'codex'];
export function brainAsAgent(b: { provider?: string; model?: string; effort?: Effort | '' } | null | undefined = state.data?.settings?.brain): ModelTarget & { model: string; provider: string } {
  const p = b?.provider || 'claude';
  const model = p === 'venice' ? b?.model || state.data?.settings?.defaults?.veniceModel || '' : b?.model ?? (p === 'claude' ? 'haiku' : '');
  return { engine: BRAIN_ENGINE[p] || 'claude-code', model, provider: p === 'venice' ? 'venice' : 'openrouter', effort: b?.effort || '' };
}
export function brainSettingFromChoice(choice: ModelPatch): BrainSetting | null {
  const provider = choice.engine === 'openai' ? choice.provider === 'venice' ? 'venice' : !choice.provider || choice.provider === 'openrouter' ? 'openrouter' : undefined : BRAIN_PROVIDER[choice.engine];
  return provider ? { provider, model: choice.model || '', effort: choice.effort } : null;
}
export function brainModelChip({ onChange, prefix = 'Brain · ' }: { onChange?: (brain: BrainSetting) => void; prefix?: string } = {}): HTMLButtonElement {
  const { chip, draw } = makeChip("The Brain's model: answers about the project, builds teams and agents, hands out work", () => {
    const a = brainAsAgent();
    const mi = modelInfo(a);
    return <ChipFace brand={mi.brand} engine={a.engine} label={`${prefix}${mi.short}`} effort={effortOf(a)} latest={false} />;
  });
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(chip, brainAsAgent(), async (patch) => {
      const sameOne = sameModel(brainAsAgent(), patch);
      // (an engine the Brain can't think with is not offered; never quietly swap in Claude for one)
      const brain = brainSettingFromChoice(patch);
      if (!brain) {
        toast("The Brain can't use that engine. Pick Claude, OpenRouter, Venice, Hermes or Codex.", 'error');
        return false;
      }
      const r = await attempt(() => PUT('/settings', { brain }));
      if (!r) return false;
      if (state.data?.settings) state.data.settings.brain = brain;
      flushSync(draw);
      refreshSoon(0);
      const e = effortOf(brainAsAgent(brain));
      toast(sameOne ? `The Brain now thinks at ${e ? `${EFFORT_NAMES[e].toLowerCase()} effort` : "the model's default effort"}` : `The Brain now thinks with ${withEffort(brainAsAgent(brain))}`);
      onChange?.(brain);
      return true;
    }, { title: "The Brain's model", local: false, engines: BRAIN_ENGINES });
  });
  return chip;
}

// ---------- the picker's rows, tabs and boxes ----------
const STAR_CLASS = 'flex-none grid place-items-center size-7 mr-0.5 rounded-[6px] text-faint cursor-pointer opacity-0 [transition:opacity_.15s,color_.15s,background_.15s] group-hover:opacity-100 focus-visible:opacity-100 hover:text-accent hover:bg-panel-2 [&.on]:opacity-100 [&.on]:text-accent [&.on_.ico-svg]:fill-current [@media(hover:none)]:opacity-100';
const EFFORT_LEVEL_CLASS = 'flex-1 min-w-0 py-1.5 px-0.5 border border-line rounded-ctl text-dim font-sans text-[12px] font-medium leading-[normal] cursor-pointer whitespace-nowrap [transition:border-color_.15s,color_.15s,background_.15s] hover:text-ink hover:bg-panel-2 [&.on]:border-accent [&.on]:text-accent [&.on]:bg-accent/10';
const TAB_CLASS = "flex flex-col items-center gap-1 py-2 px-0.5 border border-line rounded-[8px] text-dim font-sans text-[11.5px] font-medium leading-[normal] cursor-pointer [transition:border-color_.15s,color_.15s,background_.15s] hover:text-ink hover:bg-panel-2 [&.on]:border-accent [&.on]:text-accent [&.on]:bg-accent/10 [&.cur]:after:content-[''] [&.cur]:after:size-1.25 [&.cur]:after:rounded-full [&.cur]:after:bg-accent";
const MISSING_CLASS = 'flex items-center gap-2 mx-1.5 mb-1.5 px-2.25 py-1.75 rounded-[8px] text-[12px] text-amber bg-amber/10';
const SHORT: Record<Effort, string> = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'X-High', max: 'Max' };
/** How the class of a row is spelled: the markers a test or the app looks up, then the look. */
const classes = (...parts: (string | false)[]) => parts.filter(Boolean).join(' ');

/** The mark on a row: a check when it is the model in use, else its brand logo or a cpu icon. */
function RowMark({ active, brand }: { active: boolean; brand: string | null }) {
  if (active) return <Icon name="check" size={15} />;
  return <BrandMark brand={brand} size={14} fallback={<Icon name="cpu" size={15} />} />;
}

/** The star that saves a model as a favorite (saved in Settings, so every picker shows it). */
function FavStar({ choice, onChanged }: { choice: ModelChoice; onChanged: () => void }) {
  const [on, setOn] = useState(() => isFavorite(choice));
  return (
    <button
      type="button"
      className={classes('model-fav', on && 'on', STAR_CLASS)}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        void toggleFavorite(choice).then((next) => {
          setOn(next);
          onChanged();
        });
      }}
    >
      <Icon name="star" size={14} />
    </button>
  );
}

/** One model in the list: its name and where it runs, and the star beside it. */
function Row({ label, sub, active, choice, brand = null, disabled = false, onPick, onChanged }: { label: string; sub: string | null; active: boolean; choice: ModelChoice; brand?: string | null; disabled?: boolean; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  return (
    <div className="model-row group flex items-center gap-0.5">
      <button type="button" disabled={disabled} className={classes('st-menu-item', active && 'on', 'flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed')} onClick={() => onPick(choice)}>
        <RowMark active={active} brand={brand} />
        <span className="flex-1 min-w-0">
          {label}
          {sub ? <span className="model-sub">{sub}</span> : null}
        </span>
      </button>
      <FavStar choice={choice} onChanged={onChanged} />
    </div>
  );
}

/** A box to type a model id the list hasn't got (Enter picks it). */
function FreeInput({ placeholder, onSubmit }: { placeholder: string; onSubmit: (model: string) => void }) {
  const box = useRef<HTMLInputElement>(null);
  // (a listener on the box itself, and the id read off it: the box is only typed in, never read back)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      const v = el.value.trim();
      if (e.key === 'Enter' && v) onSubmit(v);
    };
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
  }, [onSubmit]);
  return <input ref={box} className={SEARCH} placeholder={placeholder} />;
}

/** A line saying something isn't set up on this PC yet, and the way to Settings. */
function Missing({ text, find, close }: { text: string; find: string; close: () => void }) {
  return (
    <div className={MISSING_CLASS}>
      <Icon name="triangle-alert" size={14} />
      <span className="flex-1 min-w-0">{text}</span>
      <Button size="tiny" type="button" onClick={() => { close(); navigate(`#/settings?tab=general&find=${encodeURIComponent(find)}`); }}>
        Set up
      </Button>
    </div>
  );
}

/** The mark on a tab: a star for Favorites, else the engine's own app icon, logo or glyph. */
function TabMark({ tab }: { tab: ModelTab }) {
  if (tab.engine === 'fav') return <Icon name="star" size={13} />;
  if (brandImage(tab.engine, 13)) return <DomNode as="span" className="dom-contents" make={() => brandImage(tab.engine, 13)} deps={[tab.engine]} />;
  if (tab.brand && brandPath(tab.brand)) return <BrandMark brand={tab.brand} size={13} fallback={null} />;
  if (appIconUrl(tab.engine)) return <DomNode as="span" className="dom-contents" make={() => appIcon(tab.engine, 13)} deps={[tab.engine]} />;
  return <span className="text-[13px] leading-[13px]">{tab.glyph || '•'}</span>;
}

/** One level of effort ('' is the model's own default). */
function LevelButton({ value, shown, onPick }: { value: Effort | ''; shown: Effort | ''; onPick: (v: Effort | '') => void }) {
  const on = shown === value;
  return (
    <button
      type="button"
      className={classes('model-effort-level', on && 'on', EFFORT_LEVEL_CLASS)}
      title={value ? `${EFFORT_NAMES[value]} effort` : "The model's own default"}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        onPick(value);
      }}
    >
      {value ? SHORT[value] : 'Default'}
    </button>
  );
}

/** The models a server on this PC offers (LM Studio, Ollama, a custom one): its own list, and a box to type one. */
function LocalSection({ provider, label, howToStart = '', cur, onPick, onChanged }: { provider: string; label: string; howToStart?: string; cur: ModelTarget; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const [ids, setIds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    GET<ModelListing[]>(`/models?engine=openai&provider=${provider}`).then(
      (ms) => { if (live) setIds(ms.map((m) => m.id)); },
      () => { if (live) setIds([]); },
    );
    return () => { live = false; };
  }, [provider]);
  // the model in use needs an id of its own: an empty one would fall back to the OpenRouter default
  const mine = cur.engine === 'openai' && cur.provider === provider && cur.model ? cur.model : null;
  const list = ids === null ? null : mine && !ids.includes(mine) ? [mine, ...ids] : ids;
  const on = (id: string) => cur.engine === 'openai' && cur.provider === provider && cur.model === id;
  return (
    <>
      <div className="st-menu-head">{`On this PC · ${label}`}</div>
      <div className="model-list">
        {list === null ? (
          <div className="model-sub px-2.5 py-1">Looking for models…</div>
        ) : list.length ? (
          list.map((id) => <Row key={id} label={id} sub={null} active={on(id)} choice={{ engine: 'openai', provider, model: id }} brand={provider === 'ollama' ? 'ollama' : null} onPick={onPick} onChanged={onChanged} />)
        ) : (
          <div className="model-sub px-2.5 py-1">{`No models found. Is ${label} running?${howToStart ? ` (${howToStart})` : ''}`}</div>
        )}
      </div>
      <FreeInput placeholder={`or type a ${label} model id and press Enter`} onSubmit={(m) => onPick({ engine: 'openai', provider, model: m })} />
    </>
  );
}

/** Favorites: the models starred in Settings this picker can use. */
function FavoritesBody({ favs, cur, isUnavailable, onPick, onChanged }: { favs: FavoriteModel[]; cur: ModelTarget; isUnavailable: (c: ModelChoice) => boolean; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  return (
    <>
      <div className="st-menu-head">Favorites</div>
      {favs.map((f) => {
        const mi = modelInfo(f);
        const offline = isUnavailable(f);
        return <Row key={`${f.engine} ${f.provider || ''} ${f.model}`} label={mi.name || f.model} sub={`${mi.where}${offline ? ' · Temporarily unavailable' : ''}`} active={sameModel(cur, f)} disabled={offline} choice={f} brand={mi.brand} onPick={onPick} onChanged={onChanged} />;
      })}
    </>
  );
}

/** Claude Code: the four short names (always the newest), and the versions pinned today. */
function ClaudeBody({ cur, close, onPick, onChanged }: { cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const eng: Partial<EngineStatus> = state.data?.engines || {};
  const same = (model: string) => cur.engine === 'claude-code' && String(cur.model || '') === model;
  return (
    <>
      {eng['claude-code'] && !eng['claude-code'].installed ? <Missing text="Claude Code is not installed on this PC." find="Claude Code" close={close} /> : null}
      <div className="st-menu-head">Always the newest</div>
      {CLAUDE.map((c) => <Row key={c.id} label={`${c.family} (latest)`} sub={`now ${c.version} · ${c.note}`} active={same(c.alias)} choice={{ engine: 'claude-code', model: c.alias }} brand="claude" onPick={onPick} onChanged={onChanged} />)}
      <div className="st-menu-head">Pinned version</div>
      {CLAUDE.map((c) => <Row key={`pin ${c.id}`} label={`${c.family} ${c.version}`} sub={c.id} active={same(c.id)} choice={{ engine: 'claude-code', model: c.id }} brand="claude" onPick={onPick} onChanged={onChanged} />)}
    </>
  );
}

function VeniceBody({ cur, models, error, close, onPick, onChanged }: { cur: ModelTarget; models: ModelListing[] | null; error: string | null; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const current = cur.engine === 'openai' && cur.provider === 'venice' ? cur.model : '';
  const list = models || [];
  const pool: ModelListing[] = current && !list.some((m) => m.id === current) ? [{ id: current, name: current }, ...list] : list;
  const shown = pool.filter((m) => `${m.id} ${m.name || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 80);
  return <>
    {state.data?.secrets?.veniceKey?.set ? null : <Missing text="Add your Venice key to run a model." find="Venice key" close={close} />}
    <div className="st-menu-head">Venice</div>
    <input className={SEARCH} aria-label="Search Venice models" placeholder="Search Venice models" value={query} onChange={(e) => setQuery(e.target.value)} />
    {models === null && !error ? <p className="model-sub px-2.5 py-1" role="status">Loading Venice models…</p> : null}
    {error ? <p className="model-sub px-2.5 py-1" role="status">{error} You can enter a model id below.</p> : null}
    {models && !models.length ? <p className="model-sub px-2.5 py-1">No Venice models found. Enter a model id below or try again later.</p> : null}
    {models?.length && !shown.length ? <p className="model-sub px-2.5 py-1">No models match this search.</p> : null}
    <div className="model-list">{shown.map((m) => <Row key={m.id} label={m.name || m.id}
      sub={[m.id, m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : '', m.context ? `${Math.round(m.context / 1000)}k context` : '', m.tools === false ? 'No tool use' : '', m.offline ? 'Temporarily unavailable' : ''].filter(Boolean).join(' · ')}
      active={m.id === current} disabled={m.offline} choice={{ engine: 'openai', provider: 'venice', model: m.id }} onPick={onPick} onChanged={onChanged} />)}</div>
    <FreeInput placeholder="or enter a Venice model id and press Enter" onSubmit={(model) => onPick({ engine: 'openai', provider: 'venice', model })} />
  </>;
}

/** OpenRouter: its own list (as much as the server knows), the picks everyone wants, and any server on this PC. */
function OpenRouterBody({ cur, local, close, onPick, onChanged }: { cur: ModelTarget; local: boolean; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const hasKey = !!state.data?.secrets?.openrouterKey?.set;
  const [q, setQ] = useState('');
  const [all, setAll] = useState<ModelListing[]>([]);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    GET<ModelListing[]>('/models?engine=openai&provider=openrouter')
      .then((ms) => { if (live) setAll(ms); })
      .catch(() => {});
    const focus = setTimeout(() => search.current?.focus(), 30);
    return () => { live = false; clearTimeout(focus); };
  }, []);
  const pool: ModelListing[] = all.length ? all : OPENROUTER_PICKS.map((id) => ({ id, name: id }));
  const ql = q.toLowerCase();
  const shown = (ql ? pool.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(ql)) : pool.filter((m) => OPENROUTER_PICKS.includes(m.id) || m.id === cur.model).concat(pool.filter((m) => !OPENROUTER_PICKS.includes(m.id)).slice(0, 25))).slice(0, 60);
  // Enter picks whatever id is in the box (a listener on the box itself, so it is read off the element)
  useEffect(() => {
    const el = search.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      const v = el.value.trim();
      if (e.key === 'Enter' && v) onPick({ engine: 'openai', provider: 'openrouter', model: v });
    };
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
  }, [onPick]);
  return (
    <>
      {hasKey ? null : <Missing text="Add your OpenRouter key first." find="OpenRouter key" close={close} />}
      <div className="st-menu-head">OpenRouter</div>
      <input
        ref={search}
        className={SEARCH}
        placeholder="Search 300+ models (gpt, gemini, llama, deepseek…)"
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <div className="model-list">
        {shown.map((m) => (
          <Row
            key={m.id}
            label={m.name || m.id}
            sub={m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : m.id}
            active={cur.engine === 'openai' && (cur.provider || 'openrouter') === 'openrouter' && m.id === cur.model}
            choice={{ engine: 'openai', provider: 'openrouter', model: m.id }}
            brand={/claude|anthropic/.test(m.id) ? 'claude' : null}
            onPick={onPick}
            onChanged={onChanged}
          />
        ))}
      </div>
      {local ? <LocalSection provider="ollama" label="Ollama" cur={cur} onPick={onPick} onChanged={onChanged} /> : null}
      {local ? <LocalSection provider="custom" label="Custom server" cur={cur} onPick={onPick} onChanged={onChanged} /> : null}
    </>
  );
}

/** Hermes: the profile's own model, or one of the picks, or any id typed in. */
function HermesBody({ cur, close, onPick, onChanged }: { cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const eng: Partial<EngineStatus> = state.data?.engines || {};
  const same = (model: string) => cur.engine === 'hermes' && String(cur.model || '') === model;
  return (
    <>
      {eng.hermes && !eng.hermes.installed ? <Missing text="Hermes is not installed on this PC." find="Hermes" close={close} /> : null}
      <div className="st-menu-head">Hermes</div>
      <Row label="The profile's own model" sub="whatever your Hermes profile uses" active={same('')} choice={{ engine: 'hermes', model: '' }} onPick={onPick} onChanged={onChanged} />
      {OPENROUTER_PICKS.slice(1).map((id) => <Row key={id} label={id.split('/').pop()!} sub={id} active={same(id)} choice={{ engine: 'hermes', model: id }} brand="claude" onPick={onPick} onChanged={onChanged} />)}
      <FreeInput placeholder="or type a model id and press Enter" onSubmit={(m) => onPick({ engine: 'hermes', model: m })} />
    </>
  );
}

/** A CLI engine with its own model list (GET /models?engine=…): what it is set to use, and its list. */
function CliBody({ engine, cur, close, onPick, onChanged }: { engine: 'pi' | 'omp' | 'openclaw'; cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const eng: Partial<EngineStatus> = state.data?.engines || {};
  const t = CLI_TABS[engine]!;
  const [q, setQ] = useState('');
  const [all, setAll] = useState<ModelListing[] | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    GET<ModelListing[]>(`/models?engine=${engine}`).then(
      (ms) => { if (live) setAll(ms); },
      () => { if (live) setAll([]); },
    );
    return () => { live = false; };
  }, [engine]);
  const same = (model: string) => cur.engine === engine && String(cur.model || '') === model;
  const ql = q.toLowerCase();
  const shown = (ql && all ? all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(ql)) : all || []).slice(0, 60);
  // Enter picks whatever id is in the box (a listener on the box itself, so it is read off the element)
  useEffect(() => {
    const el = search.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      const v = el.value.trim();
      if (e.key === 'Enter' && v) onPick({ engine, model: v });
    };
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
  }, [engine, onPick]);
  return (
    <>
      {eng[engine] && !eng[engine].installed ? <Missing text={`${t.name} is not installed on this PC.`} find={t.find} close={close} /> : null}
      <div className="st-menu-head">{t.name}</div>
      <Row label={t.own} sub="whatever it is set to use" active={same('')} choice={{ engine, model: '' }} onPick={onPick} onChanged={onChanged} />
      <input
        ref={search}
        className={SEARCH}
        placeholder="Search its models, or type a provider/model id and press Enter"
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <div className="model-list">
        {all === null ? (
          <div className="model-sub px-2.5 py-1">Looking for models…</div>
        ) : all.length ? (
          shown.map((m) => <Row key={m.id} label={m.name || m.id} sub={m.id} active={same(m.id)} choice={{ engine, model: m.id }} brand={/claude|anthropic/.test(m.id) ? 'claude' : null} onPick={onPick} onChanged={onChanged} />)
        ) : (
          <div className="model-sub px-2.5 py-1">{`No models listed. Sign ${t.name} in to a provider, or type a model id.`}</div>
        )}
      </div>
    </>
  );
}

/** Codex: its own list from the server (a small built-in one when that can't be reached). */
function CodexBody({ cur, close, onPick, onChanged }: { cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const eng: Partial<EngineStatus> = state.data?.engines || {};
  const cx: Partial<EngineStatus['codex']> = eng.codex || {};
  const [all, setAll] = useState<ModelListing[] | null>(null);
  useEffect(() => {
    let live = true;
    GET<ModelListing[]>('/models?engine=codex').then(
      (ms) => { if (live) setAll(ms.some((m) => m.id) ? ms : CODEX_PICKS); },
      () => { if (live) setAll(CODEX_PICKS); },
    );
    return () => { live = false; };
  }, []);
  const same = (model: string) => cur.engine === 'codex' && String(cur.model || '') === model;
  return (
    <>
      {!cx.installed ? <Missing text="Codex is not installed yet." find="OpenAI Codex" close={close} /> : !cx.loggedIn ? <Missing text="Codex is installed but not signed in." find="OpenAI Codex" close={close} /> : null}
      <div className="st-menu-head">OpenAI Codex · your ChatGPT login</div>
      <Row label="Codex's default model" sub="whatever Codex picks" active={same('')} choice={{ engine: 'codex', model: '' }} brand="openai" onPick={onPick} onChanged={onChanged} />
      <div className="model-list">
        {all === null ? (
          <div className="model-sub px-2.5 py-1">Looking for models…</div>
        ) : (
          all.filter((m) => m.id).map((m) => <Row key={m.id} label={m.name || m.id} sub={m.description ? `${m.id} · ${m.description}` : m.id} active={same(m.id)} choice={{ engine: 'codex', model: m.id }} brand="openai" onPick={onPick} onChanged={onChanged} />)
        )}
      </div>
      <FreeInput placeholder="or type a model id and press Enter" onSubmit={(m) => onPick({ engine: 'codex', model: m })} />
    </>
  );
}

interface PickerProps {
  anchor: Element;
  cur: ModelTarget;
  apply: (patch: ModelPatch) => unknown;
  title: string;
  local: boolean;
  engines?: readonly EngineId[];
  providers?: readonly string[];
  open: boolean;
  close: () => void;
  dispose: () => void;
}

/** The picker: a tab for Favorites (when there are any) and one per engine, the effort row, and that tab's models. */
function ModelPicker({ anchor, cur, apply, title, local, engines, providers, open, close, dispose }: PickerProps) {
  const usable = (e: EngineId) => !engines || engines.includes(e);
  // favorites this picker can use (without local servers, only OpenRouter's API models)
  const favs = () => favoriteModels().filter((f) => usable(f.engine) && (!providers || f.engine !== 'openai' || providers.includes(f.provider || 'openrouter')) && (local || f.engine !== 'openai' || ['openrouter', 'venice'].includes(f.provider || 'openrouter')));
  // LM Studio's tab only where models on this PC can be used (not for the Brain)
  const myTabs = TABS.filter((t) => (local || t.engine !== 'lmstudio') && (!providers || providers.includes(t.engine === 'openai' ? 'openrouter' : t.engine)) && (t.engine === 'fav' || usable(t.engine === 'lmstudio' || t.engine === 'venice' ? 'openai' : t.engine)));
  const curTab = tabOf(cur);
  const homeTab = (): PickerTab => (myTabs.some((t) => t.engine === curTab) ? curTab : myTabs[0]?.engine || 'claude-code');
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [tab, setTab] = useState<PickerTab>(() => (favs().length ? 'fav' : homeTab()));
  // the effort asked for (kept as asked: each engine sends its nearest level)
  const [effort, setEffort] = useState<Effort | ''>(() => effortOf(cur));
  const asked = useRef<Effort | ''>(effort);
  const [veniceModels, setVeniceModels] = useState<ModelListing[] | null>(null);
  const [veniceError, setVeniceError] = useState<string | null>(null);
  const needsVenice = tab === 'venice' || (cur.engine === 'openai' && cur.provider === 'venice') || (tab === 'fav' && favs().some((f) => f.provider === 'venice'));
  useEffect(() => {
    if (!needsVenice) return;
    let live = true;
    setVeniceError(null);
    void GET<ModelListing[]>('/models?engine=openai&provider=venice').then(
      (models) => { if (live) setVeniceModels(models); },
      () => { if (live) setVeniceError('Could not load Venice models.'); },
    );
    return () => { live = false; };
  }, [needsVenice]);
  const favList = favs();
  // (the last favorite just went: back to the engine in use)
  if (tab === 'fav' && !favList.length) setTab(homeTab());
  const setLevel = (value: Effort | '') => {
    asked.current = value;
    setEffort(value);
  };
  const tabEngine = (): EngineId => (tab === 'fav' ? cur.engine : tab === 'lmstudio' || tab === 'venice' ? 'openai' : tab);
  // the effort row is for the model in use, on Favorites and its own tab; on the others it is for what you pick here
  const live = tab === 'fav' || tab === curTab;
  const engine = tabEngine();
  const provider = engine !== 'openai' ? undefined : live ? cur.provider : tab === 'lmstudio' ? 'lmstudio' : tab === 'venice' ? 'venice' : 'openrouter';
  const levelsFor = (choice: ModelChoice) => choice.provider === 'venice' ? veniceModels?.find((m) => m.id === choice.model)?.reasoningEfforts : undefined;
  const modelLevels = provider === 'venice' ? live ? levelsFor(cur) : veniceModels?.flatMap((m) => m.reasoningEfforts || []) : undefined;
  const levels = effortLevels(engine, provider, modelLevels);
  const shown = effortFor(engine, effort, provider, modelLevels);
  const isUnavailable = (choice: ModelChoice): boolean => choice.engine === 'openai' && choice.provider === 'venice' && veniceModels?.find((m) => m.id === choice.model)?.offline === true;

  // Picking a model closes the picker; changing the effort of the model in use applies it at once and keeps it open.
  const pick = (choice: ModelChoice) => {
    if (isUnavailable(choice)) return toast('This Venice model is temporarily unavailable. Choose another model.', 'warn');
    close();
    void apply({ ...choice, effort: effortFor(choice.engine, asked.current, choice.provider, levelsFor(choice)) });
  };
  const changeEffort = async (value: Effort | '') => {
    const before = asked.current;
    // synchronously, like typing: the row shows the level the moment it is clicked
    flushSync(() => setLevel(value));
    if (!live) return;
    const ok = await apply({ engine: cur.engine, model: cur.model ?? '', ...(cur.engine === 'openai' ? { provider: cur.provider } : {}), effort: effortFor(cur.engine, value, cur.provider, levelsFor(cur)) });
    // (it failed: the row goes back to what it was)
    if (ok === false && asked.current === value) setLevel(before);
  };

  const menu = useRef<HTMLDivElement>(null);
  // Escape closes the picker and hands focus back; a click anywhere else closes it (the plain-DOM menu did both itself)
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      if (anchor instanceof HTMLElement) anchor.focus();
    };
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node | null)) close();
    };
    document.addEventListener('keydown', escape, true);
    // (armed a moment later, so the click that opened the menu doesn't close it again)
    const armed = setTimeout(() => document.addEventListener('pointerdown', outside, true));
    return () => {
      clearTimeout(armed);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, anchor, close]);

  let body: ReactNode;
  if (tab === 'fav') body = <FavoritesBody favs={favList} cur={cur} isUnavailable={isUnavailable} onPick={pick} onChanged={refresh} />;
  else if (tab === 'claude-code') body = <ClaudeBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'openai') body = <OpenRouterBody cur={cur} local={local} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'venice') body = <VeniceBody cur={cur} models={veniceModels} error={veniceError} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'lmstudio') body = <LocalSection provider="lmstudio" label="LM Studio" howToStart="LM Studio > Developer > Start server" cur={cur} onPick={pick} onChanged={refresh} />;
  else if (tab === 'hermes') body = <HermesBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'pi' || tab === 'omp' || tab === 'openclaw') body = <CliBody engine={tab} cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else body = <CodexBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;

  const shownTabs: ModelTab[] = favList.length ? [{ engine: 'fav', label: 'Favorites', brand: null }, ...myTabs] : myTabs;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        close();
        if (details.reason === 'escape-key' && anchor instanceof HTMLElement) anchor.focus();
      }}
      onOpenChangeComplete={(next) => { if (!next) setTimeout(dispose, 0); }}
    >
      <PopoverContent
        ref={menu}
        positioner={{ anchor }}
        initialFocus={false}
        finalFocus={false}
        className="model-menu data-[ending-style]:pointer-events-none"
      >
        <div className="st-menu-head">{title}</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(66px,1fr))] gap-1.5 pt-1 px-2 pb-3">
          {shownTabs.map((t) => (
            <button
              key={t.engine}
              type="button"
              className={classes('model-tab', tab === t.engine && 'on', curTab === t.engine && 'cur', TAB_CLASS)}
              title={curTab === t.engine ? `${t.label} (in use)` : t.label}
              onClick={(e) => {
                e.stopPropagation();
                // synchronously: the effort row and the list below change with the tab
                flushSync(() => setTab(t.engine));
              }}
            >
              <TabMark tab={t} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        {provider !== 'venice' || levels.length ? <div className="px-2 pb-3 border-b border-line mb-1.5">
          <div className="flex items-center gap-1.5 px-1 pb-2 font-sans text-[12px] font-medium leading-[normal] text-dim">
            <Icon name="gauge" size={13} />
            <span>Effort</span>
            <span className="ml-auto font-normal text-faint">{live ? 'how hard it thinks' : 'for the model you pick here'}</span>
          </div>
          <div className="flex gap-1" role="group" aria-label="Effort">
            <LevelButton value="" shown={shown} onPick={(v) => void changeEffort(v)} />
            {levels.map((level) => <LevelButton key={level} value={level} shown={shown} onPick={(v) => void changeEffort(v)} />)}
          </div>
        </div> : null}
        <div className="model-body max-h-95 overflow-y-auto">{body}</div>
      </PopoverContent>
    </PopoverRoot>
  );
}

// ---------- the picker ----------
// cur: { engine, model, provider, effort }. apply(patch) gets { engine, model, provider?, effort }.
// Picking a model closes the picker; changing the effort of the model in use applies it at once and keeps it open
// (apply returns, or resolves to, false when that failed: the row goes back to what it was).
// local: offer models on this PC (LM Studio, Ollama, a custom server); the Brain can't use them.
// engines: only these engines' tabs and favorites (the Brain's picker); all when left out.
let closeModelMenu: (() => void) | null = null;

export function openModelPicker(anchor: Element, cur: ModelTarget, apply: (patch: ModelPatch) => unknown, { title = 'Model', local = true, engines, providers }: { title?: string; local?: boolean; engines?: readonly EngineId[]; providers?: readonly string[] } = {}): void {
  if (cur.engine === 'openai' && !cur.model) cur = { ...cur, model: defaultModelForEngine('openai', state.data?.settings?.defaults || {}, cur.provider) };
  // one picker at a time: whatever is up goes first, at once, so two are never in the way
  closeModelMenu?.();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let open = true;
  let done = false;
  let timer: number | undefined;
  const render = (isOpen: boolean) => root.render(<ModelPicker anchor={anchor} cur={cur} apply={apply} title={title} local={local} engines={engines} providers={providers} open={isOpen} close={close} dispose={remove} />);
  const remove = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (closeModelMenu === remove) closeModelMenu = null;
    // (a page that was drawn over the menu left nothing to unmount)
    if (host.isConnected) root.unmount();
    host.remove();
  };
  const close = () => {
    if (!open) return;
    open = false;
    render(false);
    // it fades out with the page's own exit; this is the backstop in case it never says it is done
    clearTimeout(timer);
    timer = setTimeout(remove, 300);
  };
  closeModelMenu = remove;
  // (the popup is there the moment this returns: the chip's click reads it straight away)
  flushSync(() => render(true));
}
