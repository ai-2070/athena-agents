// Model names with versions, and one picker used everywhere a model can be switched
// (agents, the Brain chat, Settings): tabs for your favorites and each engine (Claude Code, Eve, Hermes, Codex, pi,
// oh-my-pi and OpenClaw), where Eve's models come from (OpenRouter, Venice or a server on this PC),
// and how hard the model thinks (effort). The chips and the picker are React now: a chip is still the plain button
// callers pass around (React draws what is inside it), and the picker mounts against the chip it opened from.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createAppRoot } from './ui/root.tsx';
import { state, attempt, refreshSoon, toast, navigate } from './core.ts';
import { rpc, rpcAt } from './client/rpc.ts';
import { engineConfigured } from './engineavailability.ts';
import { slideSegment } from './segmotion.ts';
import { brandImage } from './brandimages.ts';
import { appIcon, appIconUrl } from './appicons.ts';
import { brandPath, logo } from './icons.ts';
import { EFFORT_NAMES, effortFor, effortLevels, isEffort } from '../shared/effort.ts';
import { defaultModelForEngine } from '../shared/modeldefaults.ts';
import { Button } from './ui/button.tsx';
import { Chips } from './ui/controls.tsx';
import { EveMark } from './ui/evemark.tsx';
import { PopoverContent, PopoverRoot } from './ui/popover.tsx';
import { DomNode, Icon, useAppState } from './ui/react.tsx';
import type { Agent, BrainSetting, Effort, EngineId, EngineStatus, FavoriteModel, ModelListing } from '../shared/types.ts';

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
export type { ModelListing } from '../shared/types.ts';
/** A picker tab: an engine, or Favorites. */
type PickerTab = EngineId | 'fav';
interface ModelTab {
  engine: PickerTab;
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
// shown when the server can't be reached; normally Codex's own list comes from GET /models?engine=codex
const CODEX_PICKS: ModelListing[] = [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' }];

const TABS: ModelTab[] = [
  { engine: 'claude-code', label: 'Claude', brand: 'claude' },
  { engine: 'eve', label: 'Eve', brand: null },
  { engine: 'hermes', label: 'Hermes', brand: null },
  { engine: 'codex', label: 'Codex', brand: 'openai' },
  { engine: 'pi', label: 'pi', brand: null },
  { engine: 'omp', label: 'OMP', brand: null },
  { engine: 'openclaw', label: 'OpenClaw', brand: null },
];
// Where Eve's models come from. local: a server on this PC or one you point to (the Brain can't use them).
const EVE_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', local: false },
  { id: 'venice', label: 'Venice', local: false },
  { id: 'lmstudio', label: 'LM Studio', local: true },
  { id: 'ollama', label: 'Ollama', local: true },
  { id: 'custom', label: 'Custom server', local: true },
] as const;
type EveProvider = (typeof EVE_PROVIDERS)[number]['id'];
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
export const effortOf = (a: ModelTarget): Effort | '' => a.engine === 'eve' && a.provider === 'venice' ? isEffort(a.effort) ? a.effort : '' : effortFor(a.engine, a.effort, a.provider);
/** "Claude Opus 5.5" or "Claude Opus 5.5 (high effort)" */
const withEffort = (a: ModelTarget) => {
  const e = effortOf(a);
  return `${modelInfo(a).name}${e ? ` (${EFFORT_NAMES[e].toLowerCase()} effort)` : ''}`;
};
const sameModel = (a: ModelChoice, b: ModelChoice) => a.engine === b.engine && String(a.model || '') === String(b.model || '') && (a.engine !== 'eve' || (a.provider || 'openrouter') === (b.provider || 'openrouter'));

// ---------- favorites (Settings: favoriteModels) ----------
const ENGINES: EngineId[] = ['claude-code', 'eve', 'hermes', 'codex', 'pi', 'omp', 'openclaw'];
export function favoriteModels(): FavoriteModel[] {
  const list = state.data?.settings?.favoriteModels;
  return Array.isArray(list) ? list.filter((f) => f && ENGINES.includes(f.engine) && typeof f.model === 'string') : [];
}
export const isFavorite = (m: ModelChoice) => favoriteModels().some((f) => sameModel(f, m));
/** Star or unstar a model. Saved in Settings, so every picker shows it. */
export async function toggleFavorite(m: ModelChoice): Promise<boolean> {
  const before = favoriteModels();
  const on = !before.some((f) => sameModel(f, m));
  const fav: FavoriteModel = { engine: m.engine, model: m.model || '', ...(m.engine === 'eve' ? { provider: m.provider || 'openrouter' } : {}) };
  const list = on ? [...before, fav] : before.filter((f) => !sameModel(f, m));
  if (state.data?.settings) state.data.settings.favoriteModels = list;
  const r = await attempt(() => rpc.settings.save({ favoriteModels: list }));
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

/** What a chip shows: the mark of what runs it (Eve's own, whatever model it runs; else the model's), its short name,
 *  the effort, "latest" and a chevron. */
function ChipFace({ brand, engine, label, effort, latest }: { brand: string | null; engine: string; label: string; effort: Effort | ''; latest: boolean }) {
  const ownMark = !brand && brandImage(engine, 13);
  return (
    <>
      {engine === 'eve' ? <EveMark size={13} /> : <BrandMark brand={brand} size={13} fallback={ownMark ? <DomNode as="span" className="dom-contents" make={() => ownMark} deps={[engine]} /> : <Icon name="cpu" size={13} />} />}
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
  const root = createAppRoot(chip, { inline: true });
  const draw = () => root.render(face());
  // (a plain render: a chip is often made while a page is drawing, and nothing reads its words back)
  draw();
  return { chip, draw };
}

// A chip showing an agent's model; click it to switch (model or what it runs on). at: '/p/<project>' for an agent of a
// project that isn't open (projectAt).
export function modelChip(agent: Agent, { onChange, compact = false, at = '' }: { onChange?: (agent: Agent) => void; compact?: boolean; at?: string } = {}): HTMLButtonElement {
  const { chip, draw } = makeChip('Switch model', () => {
    const mi = modelInfo(agent);
    return <ChipFace brand={mi.brand} engine={agent.engine} label={mi.short} effort={effortOf(agent)} latest={mi.latest && !compact} />;
  });
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(chip, agent, async (patch) => {
      const sameOne = sameModel(agent, patch);
      const r = await attempt(() => rpcAt(at).agents.change({ id: agent.id, ...patch }));
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
const BRAIN_ENGINE: Record<string, EngineId | undefined> = { claude: 'claude-code', openrouter: 'eve', venice: 'eve', hermes: 'hermes', codex: 'codex' };
const BRAIN_PROVIDER: Record<string, BrainSetting['provider'] | undefined> = { 'claude-code': 'claude', eve: 'openrouter', hermes: 'hermes', codex: 'codex' };
/** The engines the Brain can think with (its picker offers only these). */
const BRAIN_ENGINES: readonly EngineId[] = ['claude-code', 'eve', 'hermes', 'codex'];
export function brainAsAgent(b: { provider?: string; model?: string; effort?: Effort | '' } | null | undefined = state.data?.settings?.brain): ModelTarget & { model: string; provider: string } {
  const p = b?.provider || 'claude';
  const model = p === 'venice' ? b?.model || state.data?.settings?.defaults?.veniceModel || '' : b?.model ?? (p === 'claude' ? 'haiku' : '');
  return { engine: BRAIN_ENGINE[p] || 'claude-code', model, provider: p === 'venice' ? 'venice' : 'openrouter', effort: b?.effort || '' };
}
export function brainSettingFromChoice(choice: ModelPatch): BrainSetting | null {
  const provider = choice.engine === 'eve' ? choice.provider === 'venice' ? 'venice' : !choice.provider || choice.provider === 'openrouter' ? 'openrouter' : undefined : BRAIN_PROVIDER[choice.engine];
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
      const r = await attempt(() => rpc.settings.save({ brain }));
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
const EFFORT_LEVEL_CLASS = "relative isolate flex-1 min-w-0 py-1.5 px-1 rounded-[7px] text-dim font-sans text-[12px] font-medium leading-[normal] cursor-pointer whitespace-nowrap [transition:color_.15s] hover:text-ink [&.on]:text-ink [&.on]:before:absolute [&.on]:before:inset-0 [&.on]:before:-z-10 [&.on]:before:origin-top-left [&.on]:before:rounded-[inherit] [&.on]:before:bg-panel [&.on]:before:shadow-raised [&.on]:before:content-['']";
const TAB_CLASS = "relative flex h-15 min-w-0 flex-col items-center justify-center gap-1.5 px-1 border border-line rounded-[10px] text-dim font-sans text-[11.5px] font-medium leading-[normal] cursor-pointer [transition:border-color_.15s,color_.15s,background_.15s,box-shadow_.15s] hover:text-ink hover:bg-panel-2 hover:border-line-2 [&>span:last-child]:max-w-full [&>span:last-child]:truncate [&.on]:border-accent [&.on]:text-ink [&.on]:bg-accent/10 [&.on]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)] [&.cur]:after:content-[''] [&.cur]:after:absolute [&.cur]:after:top-1.5 [&.cur]:after:right-1.5 [&.cur]:after:size-1.5 [&.cur]:after:rounded-full [&.cur]:after:bg-ok";
const MISSING_CLASS = 'flex items-center gap-2 mx-1.5 mb-1.5 px-2.25 py-1.75 rounded-[8px] text-[12px] text-amber bg-amber/10';
const SHORT: Record<Effort, string> = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'X-High', max: 'Max' };
/** A model row: its mark in a small tile, its name over where it runs, a check when it is the one in use. */
const ROW_CLASS = 'flex-1 min-w-0 gap-3! py-2! px-2! rounded-[9px]! disabled:opacity-50 disabled:cursor-not-allowed [&.on]:bg-accent/8 [&.on]:text-ink';
const ROW_TILE = 'grid size-8 flex-none place-items-center rounded-[8px] border border-line bg-panel-2 text-icon';
/** How the class of a row is spelled: the markers a test or the app looks up, then the look. */
const classes = (...parts: (string | false)[]) => parts.filter(Boolean).join(' ');

/** The mark on a row: its brand logo or a cpu icon, in a small tile. */
function RowMark({ brand }: { brand: string | null }) {
  return <span className={ROW_TILE}><BrandMark brand={brand} size={15} fallback={<Icon name="cpu" size={15} />} /></span>;
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

/** What is typed in the picker's search box: rows that don't match it draw nothing. */
const SearchQuery = createContext('');
const matches = (q: string, ...words: (string | null | undefined)[]) => !q || words.join(' ').toLowerCase().includes(q);

/** One model in the list: its name and where it runs, and the star beside it. */
function Row({ label, sub, active, choice, brand = null, disabled = false, onPick, onChanged }: { label: string; sub: string | null; active: boolean; choice: ModelChoice; brand?: string | null; disabled?: boolean; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const q = useContext(SearchQuery);
  if (!matches(q, label, sub, choice.model)) return null;
  return (
    <div className="model-row group flex items-center gap-0.5">
      <button type="button" disabled={disabled} aria-current={active || undefined} className={classes('st-menu-item', active && 'on', ROW_CLASS)} onClick={() => onPick(choice)}>
        <RowMark brand={brand} />
        <span className="flex-1 min-w-0 truncate font-medium">
          {label}
          {sub ? <span className="model-sub font-normal">{sub}</span> : null}
        </span>
        {active ? <Icon name="check" size={15} className="text-accent!" /> : null}
      </button>
      <FavStar choice={choice} onChanged={onChanged} />
    </div>
  );
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
  if (tab.engine === 'eve') return <EveMark size={13} />;
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
      {value ? SHORT[value] : 'Auto'}
    </button>
  );
}

/** The models a server on this PC offers (LM Studio, Ollama, a custom one): its own list. Enter in the search box takes
 *  any other id. */
function LocalSection({ provider, label, howToStart = '', cur, onPick, onChanged }: { provider: string; label: string; howToStart?: string; cur: ModelTarget; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const [ids, setIds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.status.models({ engine: 'eve', provider }).then(
      (ms) => { if (live) setIds(ms.map((m) => m.id)); },
      () => { if (live) setIds([]); },
    );
    return () => { live = false; };
  }, [provider]);
  // the model in use needs an id of its own: an empty one would fall back to the OpenRouter default
  const mine = cur.engine === 'eve' && cur.provider === provider && cur.model ? cur.model : null;
  const list = ids === null ? null : mine && !ids.includes(mine) ? [mine, ...ids] : ids;
  const on = (id: string) => cur.engine === 'eve' && cur.provider === provider && cur.model === id;
  return (
    <>
      <div className="st-menu-head">{provider === 'custom' ? label : `On this PC · ${label}`}</div>
      <div className="model-list">
        {list === null ? (
          <div className="model-sub px-2.5 py-1">Looking for models…</div>
        ) : list.length ? (
          list.map((id) => <Row key={id} label={id} sub={null} active={on(id)} choice={{ engine: 'eve', provider, model: id }} brand={provider === 'ollama' ? 'ollama' : null} onPick={onPick} onChanged={onChanged} />)
        ) : (
          <div className="model-sub px-2.5 py-1">{`No models found. Is ${label} running?${howToStart ? ` (${howToStart})` : ''}`}</div>
        )}
      </div>
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
  const query = useContext(SearchQuery);
  const current = cur.engine === 'eve' && cur.provider === 'venice' ? cur.model : '';
  const list = models || [];
  const pool: ModelListing[] = current && !list.some((m) => m.id === current) ? [{ id: current, name: current }, ...list] : list;
  const shown = pool.filter((m) => `${m.id} ${m.name || ''}`.toLowerCase().includes(query)).slice(0, 80);
  return <>
    {state.data?.secrets?.veniceKey?.set ? null : <Missing text="Add your Venice key to run a model." find="Venice key" close={close} />}
    <div className="st-menu-head">Venice</div>
    {models === null && !error ? <p className="model-sub px-2.5 py-1" role="status">Loading Venice models…</p> : null}
    {error ? <p className="model-sub px-2.5 py-1" role="status">{error} You can type a model id in the box above.</p> : null}
    {models && !models.length ? <p className="model-sub px-2.5 py-1">No Venice models found. Type a model id in the box above, or try again later.</p> : null}
    <div className="model-list">{shown.map((m) => <Row key={m.id} label={m.name || m.id}
      sub={[m.id, m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : '', m.context ? `${Math.round(m.context / 1000)}k context` : '', m.tools === false ? 'No tool use' : '', m.offline ? 'Temporarily unavailable' : ''].filter(Boolean).join(' · ')}
      active={m.id === current} disabled={m.offline} choice={{ engine: 'eve', provider: 'venice', model: m.id }} onPick={onPick} onChanged={onChanged} />)}</div>
  </>;
}

/** OpenRouter: its own list (as much as the server knows) and the picks everyone wants. */
function OpenRouterBody({ cur, close, onPick, onChanged }: { cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const hasKey = !!state.data?.secrets?.openrouterKey?.set;
  const q = useContext(SearchQuery);
  const [all, setAll] = useState<ModelListing[]>([]);
  useEffect(() => {
    let live = true;
    rpc.status.models({ engine: 'eve', provider: 'openrouter' })
      .then((ms) => { if (live) setAll(ms); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const pool: ModelListing[] = all.length ? all : OPENROUTER_PICKS.map((id) => ({ id, name: id }));
  const shown = (q ? pool.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : pool.filter((m) => OPENROUTER_PICKS.includes(m.id) || m.id === cur.model).concat(pool.filter((m) => !OPENROUTER_PICKS.includes(m.id)).slice(0, 25))).slice(0, 60);
  return (
    <>
      {hasKey ? null : <Missing text="Add your OpenRouter key first." find="OpenRouter key" close={close} />}
      <div className="st-menu-head">OpenRouter</div>
      <div className="model-list">
        {shown.map((m) => (
          <Row
            key={m.id}
            label={m.name || m.id}
            sub={m.price ? `$${m.price.in.toFixed(2)} / $${m.price.out.toFixed(2)} per M tokens` : m.id}
            active={cur.engine === 'eve' && (cur.provider || 'openrouter') === 'openrouter' && m.id === cur.model}
            choice={{ engine: 'eve', provider: 'openrouter', model: m.id }}
            brand={/claude|anthropic/.test(m.id) ? 'claude' : null}
            onPick={onPick}
            onChanged={onChanged}
          />
        ))}
      </div>
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
    </>
  );
}

/** A CLI engine with its own model list (GET /models?engine=…): what it is set to use, and its list. */
function CliBody({ engine, cur, close, onPick, onChanged }: { engine: 'pi' | 'omp' | 'openclaw'; cur: ModelTarget; close: () => void; onPick: (c: ModelChoice) => void; onChanged: () => void }) {
  const eng: Partial<EngineStatus> = state.data?.engines || {};
  const t = CLI_TABS[engine]!;
  const q = useContext(SearchQuery);
  const [all, setAll] = useState<ModelListing[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.status.models({ engine }).then(
      (ms) => { if (live) setAll(ms); },
      () => { if (live) setAll([]); },
    );
    return () => { live = false; };
  }, [engine]);
  const same = (model: string) => cur.engine === engine && String(cur.model || '') === model;
  const shown = (q && all ? all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : all || []).slice(0, 60);
  return (
    <>
      {eng[engine] && !eng[engine].installed ? <Missing text={`${t.name} is not installed on this PC.`} find={t.find} close={close} /> : null}
      <div className="st-menu-head">{t.name}</div>
      <Row label={t.own} sub="whatever it is set to use" active={same('')} choice={{ engine, model: '' }} onPick={onPick} onChanged={onChanged} />
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
    rpc.status.models({ engine: 'codex' }).then(
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
    </>
  );
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

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
  const data = useAppState();
  const [installedPrograms, setInstalledPrograms] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!local) return;
    let live = true;
    void rpc.programs.list({}).then((programs) => {
      if (live && Array.isArray(programs)) setInstalledPrograms(new Set(programs.filter((program) => program.installed).map((program) => program.id)));
    }).catch(() => {});
    return () => { live = false; };
  }, [local]);
  const configured = (id: string) => engineConfigured(id, data, installedPrograms);
  const usable = (e: EngineId) => !engines || engines.includes(e);
  // favorites this picker can use (without local servers, only OpenRouter's API models)
  const favs = () => favoriteModels().filter((f) => configured(f.engine === 'eve' ? f.provider || 'openrouter' : f.engine) && usable(f.engine) && (!providers || f.engine !== 'eve' || providers.includes(f.provider || 'openrouter')) && (local || f.engine !== 'eve' || ['openrouter', 'venice'].includes(f.provider || 'openrouter')));
  // Eve's sources this picker may offer (servers on this PC only where they can be used, not for the Brain), and of those
  // the ones set up (or in use now). Eve itself is built in: its tab shows even before a source is set up, to say how.
  const curProvider = cur.engine === 'eve' ? cur.provider || 'openrouter' : '';
  const eveOffered = EVE_PROVIDERS.filter((p) => (local || !p.local) && (!providers || providers.includes(p.id)));
  const eveReady = eveOffered.filter((p) => configured(p.id) || p.id === curProvider);
  const myTabs = TABS.filter((t) => usable(t.engine as EngineId) && (t.engine === 'eve' ? eveOffered.length > 0 : configured(t.engine) && (!providers || providers.includes(t.engine))));
  const curTab: PickerTab = cur.engine;
  const homeTab = (): PickerTab => (myTabs.some((t) => t.engine === curTab) ? curTab : myTabs[0]?.engine || 'claude-code');
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [requestedTab, setTab] = useState<PickerTab>(() => (favoriteModels().length ? 'fav' : curTab));
  const tab = requestedTab === 'fav' && favs().length ? 'fav' : myTabs.some((candidate) => candidate.engine === requestedTab) ? requestedTab : homeTab();
  // which of Eve's sources the Eve tab shows: the one in use, else the first set up
  const [requestedSource, setSource] = useState<string>(curProvider);
  const source: EveProvider | '' = (eveReady.find((p) => p.id === requestedSource) || eveReady[0])?.id || '';
  const sourceLabel = EVE_PROVIDERS.find((p) => p.id === source)?.label || '';
  // the effort asked for (kept as asked: each engine sends its nearest level)
  const [effort, setEffort] = useState<Effort | ''>(() => effortOf(cur));
  const asked = useRef<Effort | ''>(effort);
  const [veniceModels, setVeniceModels] = useState<ModelListing[] | null>(null);
  const [veniceError, setVeniceError] = useState<string | null>(null);
  const needsVenice = configured('venice') && ((tab === 'eve' && source === 'venice') || curProvider === 'venice' || (tab === 'fav' && favs().some((f) => f.provider === 'venice')));
  useEffect(() => {
    if (!needsVenice) return;
    let live = true;
    setVeniceError(null);
    void rpc.status.models({ engine: 'eve', provider: 'venice' }).then(
      (models) => { if (live) setVeniceModels(models); },
      () => { if (live) setVeniceError('Could not load Venice models.'); },
    );
    return () => { live = false; };
  }, [needsVenice]);
  const favList = favs();
  // (the last favorite just went: back to the engine in use)
  const setLevel = (value: Effort | '') => {
    asked.current = value;
    setEffort(value);
  };
  // the effort row is for the model in use, on Favorites and its own tab (and source); elsewhere it is for what you pick here
  const live = tab === 'fav' || (tab === curTab && (tab !== 'eve' || source === curProvider));
  const engine: EngineId = tab === 'fav' ? cur.engine : tab;
  const provider = engine !== 'eve' ? undefined : tab === 'fav' ? cur.provider : source || undefined;
  const levelsFor = (choice: ModelChoice) => choice.provider === 'venice' ? veniceModels?.find((m) => m.id === choice.model)?.reasoningEfforts : undefined;
  const modelLevels = provider === 'venice' ? live ? levelsFor(cur) : veniceModels?.flatMap((m) => m.reasoningEfforts || []) : undefined;
  const levels = effortLevels(engine, provider, modelLevels);
  const shown = effortFor(engine, effort, provider, modelLevels);
  const isUnavailable = (choice: ModelChoice): boolean => choice.engine === 'eve' && choice.provider === 'venice' && veniceModels?.find((m) => m.id === choice.model)?.offline === true;

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
    const ok = await apply({ engine: cur.engine, model: cur.model ?? '', ...(cur.engine === 'eve' ? { provider: cur.provider } : {}), effort: effortFor(cur.engine, value, cur.provider, levelsFor(cur)) });
    // (it failed: the row goes back to what it was)
    if (ok === false && asked.current === value) setLevel(before);
  };

  // the search box: it filters this tab's list; Enter takes what is typed as a model id on this tab
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const typedChoice = (model: string): ModelChoice | null =>
    tab === 'fav' ? null
    : tab === 'eve' ? source ? { engine: 'eve', provider: source, model } : null
    : { engine: tab, model };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const typedRef = useRef(typedChoice);
  typedRef.current = typedChoice;
  // (the box appears with the popup, a moment after the picker is made: a ref callback sets it up then.
  // A listener on the box itself, and the id read off it, as typing leaves it)
  const searchBox = useCallback((el: HTMLInputElement | null) => {
    search.current = el;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      const v = el.value.trim();
      if (e.key !== 'Enter' || !v) return;
      e.preventDefault();
      const choice = typedRef.current(v);
      if (choice) return pickRef.current(choice);
      // Favorites take no new id: Enter picks the first one that matches
      menu.current?.querySelector<HTMLButtonElement>('.model-body .model-row button.st-menu-item:not(:disabled)')?.click();
    };
    el.addEventListener('keydown', key);
    const focus = setTimeout(() => el.focus({ preventScroll: true }), 30);
    return () => {
      el.removeEventListener('keydown', key);
      clearTimeout(focus);
    };
  }, []);
  // nothing in the list matches: say so, and what Enter will do
  const [noMatch, setNoMatch] = useState(false);
  useLayoutEffect(() => {
    const none = !!query.trim() && !menu.current?.querySelector('.model-body .model-row');
    if (none !== noMatch) setNoMatch(none);
  });
  // the effort plate slides from the level it was on to the new one
  const effortRow = useRef<HTMLDivElement>(null);
  const lastLevel = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const on = effortRow.current?.querySelector<HTMLButtonElement>('.model-effort-level.on') ?? null;
    slideSegment(lastLevel.current, on);
    lastLevel.current = on;
  }, [shown, tab]);
  const tabName = tab === 'fav' ? 'favorites' : tab === 'eve' ? `${sourceLabel || 'Eve'} models` : `${TABS.find((t) => t.engine === tab)?.label || ''} models`;

  const menu = useRef<HTMLDivElement>(null);
  // the side it opened on (below the button, or wherever there was room): it stays there, so a tab with a shorter list
  // doesn't send it to another side. It scrolls within the room it has instead.
  const [side, setSide] = useState<(typeof SIDES)[number] | null>(null);
  // Escape closes the picker and hands focus back; a click anywhere else closes it (the plain-DOM menu did both itself)
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      if (anchor instanceof HTMLElement) anchor.focus();
    };
    // (a press on the button it opened from is left to that button's click, which closes it: see openModelPicker)
    const outside = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!menu.current?.contains(target) && !anchor.contains(target)) close();
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
  if (!myTabs.length && !favList.length) body = <Missing text="No engines are set up yet." find="Engines on this PC" close={close} />;
  else if (tab === 'fav') body = <FavoritesBody favs={favList} cur={cur} isUnavailable={isUnavailable} onPick={pick} onChanged={refresh} />;
  else if (tab === 'claude-code') body = <ClaudeBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'eve') {
    if (source === 'openrouter') body = <OpenRouterBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;
    else if (source === 'venice') body = <VeniceBody cur={cur} models={veniceModels} error={veniceError} close={close} onPick={pick} onChanged={refresh} />;
    else if (source) body = <LocalSection key={source} provider={source} label={sourceLabel} howToStart={source === 'lmstudio' ? 'LM Studio > Developer > Start server' : ''} cur={cur} onPick={pick} onChanged={refresh} />;
    else body = <Missing text={`Eve runs models from ${eveOffered.some((p) => p.local) ? 'OpenRouter, Venice, or a model server on this PC' : eveOffered.map((p) => p.label).join(' or ')}. Set one up first.`} find={eveOffered[0]?.id === 'venice' ? 'Venice key' : 'OpenRouter key'} close={close} />;
  }
  else if (tab === 'hermes') body = <HermesBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else if (tab === 'pi' || tab === 'omp' || tab === 'openclaw') body = <CliBody engine={tab} cur={cur} close={close} onPick={pick} onChanged={refresh} />;
  else body = <CodexBody cur={cur} close={close} onPick={pick} onChanged={refresh} />;

  const shownTabs: ModelTab[] = favList.length ? [{ engine: 'fav', label: 'Favorites', brand: null }, ...myTabs] : myTabs;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        if (details.reason === 'outside-press' && details.event.target instanceof Node && anchor.contains(details.event.target)) return;
        close();
        if (details.reason === 'escape-key' && anchor instanceof HTMLElement) anchor.focus();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) return void setTimeout(dispose, 0);
        const placed = SIDES.find((x) => x === menu.current?.getAttribute('data-side'));
        if (placed) setSide(placed);
      }}
    >
      <PopoverContent
        ref={menu}
        positioner={side ? { anchor, side, collisionAvoidance: { side: 'shift', align: 'shift', fallbackAxisSide: 'none' } } : { anchor }}
        initialFocus={false}
        finalFocus={false}
        className="model-menu data-[ending-style]:pointer-events-none"
      >
        <div className="flex-none px-3 pt-3 pb-2.5">
          <div className="st-menu-head truncate p-0! text-[13.5px]! font-semibold! text-ink!">{title}</div>
          <div className="mt-0.5 text-[12px] text-faint">Where it runs, how hard it thinks, and which model</div>
        </div>
        <div className="grid flex-none grid-cols-4 gap-1.5 px-3 pb-3">
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
        {tab === 'eve' && eveReady.length > 1 ? <div className="flex-none px-3 pb-2.5">
          <Chips
            label="Where Eve's model comes from"
            className="model-sources"
            options={eveReady.map((p) => ({ value: p.id, label: p.label, title: curProvider === p.id && cur.engine === 'eve' ? `${p.label} (in use)` : p.label }))}
            value={source}
            onChange={(v) => flushSync(() => setSource(v))}
          />
        </div> : null}
        {shownTabs.length && (tab !== 'eve' || source) && (provider !== 'venice' || levels.length) ? <div className="flex-none px-3 pb-2.5">
          <div className="flex items-center gap-1.5 pb-2 font-sans text-[12px] font-medium leading-[normal] text-dim">
            <Icon name="gauge" size={13} />
            <span>Effort</span>
            <span className="ml-auto font-normal text-faint">{live ? 'how hard it thinks' : 'for the model you pick here'}</span>
          </div>
          <div ref={effortRow} className="flex gap-0.5 rounded-[9px] border border-line bg-ink/[0.03] p-0.5" role="group" aria-label="Effort">
            <LevelButton value="" shown={shown} onPick={(v) => void changeEffort(v)} />
            {levels.map((level) => <LevelButton key={level} value={level} shown={shown} onPick={(v) => void changeEffort(v)} />)}
          </div>
        </div> : null}
        <div className="flex-none border-b border-line px-3 pb-3">
          <label className="relative block">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"><Icon name="search" size={14} /></span>
            <input
              ref={searchBox}
              className={`${SEARCH} my-0! pl-8.5!`}
              aria-label="Search models"
              placeholder={tab === 'fav' ? 'Search your favorites' : `Search ${tabName}, or type an id and press Enter`}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
        </div>
        <div className="model-body min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          <SearchQuery.Provider value={query.trim().toLowerCase()}>{body}</SearchQuery.Provider>
          {noMatch ? <p className="model-sub px-2.5 py-2 whitespace-normal!">{typedChoice(query.trim()) ? `Nothing here matches. Press Enter to use "${query.trim()}" as the model id.` : tab === 'fav' ? 'None of your favorites match.' : 'Nothing here matches.'}</p> : null}
        </div>
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
// providers: only these of Eve's sources and engines' tabs; all when left out.
let closeModelMenu: (() => void) | null = null;
// the picker that is open (not fading out), the button it opened from, and whether that button was pressed since:
// that press's click closes it rather than opening it again
let openOne: { anchor: Element; pressed: boolean; close: () => void } | null = null;

export function openModelPicker(anchor: Element, cur: ModelTarget, apply: (patch: ModelPatch) => unknown, { title = 'Model', local = true, engines, providers }: { title?: string; local?: boolean; engines?: readonly EngineId[]; providers?: readonly string[] } = {}): void {
  if (openOne?.anchor === anchor && openOne.pressed) return openOne.close();
  if (cur.engine === 'eve' && !cur.model) cur = { ...cur, model: defaultModelForEngine('eve', state.data?.settings?.defaults || {}, cur.provider) };
  // one picker at a time: whatever is up goes first, at once, so two are never in the way
  closeModelMenu?.();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createAppRoot(host);
  let open = true;
  let done = false;
  let timer: number | undefined;
  const render = (isOpen: boolean) => root.render(<ModelPicker anchor={anchor} cur={cur} apply={apply} title={title} local={local} engines={engines} providers={providers} open={isOpen} close={close} dispose={remove} />);
  const remove = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (closeModelMenu === remove) closeModelMenu = null;
    if (openOne?.close === close) openOne = null;
    anchor.removeEventListener('pointerdown', pressed, true);
    // (a page that was drawn over the menu left nothing to unmount)
    if (host.isConnected) root.unmount();
    host.remove();
  };
  const close = () => {
    if (!open) return;
    open = false;
    if (openOne?.close === close) openOne = null;
    render(false);
    // it fades out with the page's own exit; this is the backstop in case it never says it is done
    clearTimeout(timer);
    timer = setTimeout(remove, 300);
  };
  closeModelMenu = remove;
  const mine = { anchor, pressed: false, close };
  function pressed() {
    mine.pressed = true;
  }
  anchor.addEventListener('pointerdown', pressed, true);
  openOne = mine;
  // (the popup is there the moment this returns: the chip's click reads it straight away)
  flushSync(() => render(true));
}
