// Station: the live 3D map of your agent operation.
// The Brain sits in the middle. Every branch is a workflow: its steps stand along the branch in order,
// agents at desks, tools and checkpoints on pedestals. Beams pulse when work moves; dashed lines show
// which programs and services each step can reach. Agents not on any branch wait on the Bench.
import * as THREE from 'three';
import { h, mount, state, GET, POST, PUT, DEL, attempt, navigate, onState, approvalCard, md, ago, toast, avatar, engineBadge, promptBox, confirmBox, refreshSoon, modal, chipSet, select as dropdown } from '../core.ts';
import { openTerminal } from './agents.ts';
import { openBranchBuilder } from '../builder.ts';
import { openDock, attachToBrain } from '../dock.ts';
import { filesFromDrop, hasFiles } from '../attach.ts';
import { uiZoom } from '../look.ts';
import { openChat, refreshChatTabs, restoreChats, closeChatsForProject } from '../chatwin.ts';
import { skillPicker } from '../skillpick.ts';
import { historyButton } from '../history.ts';
import { logoUrl, projectMark, pickLogo, removeLogo } from '../projectlogo.ts';
import { slideIn, slideOut } from '../motion.ts';
import { icon, logo, brandPath } from '../icons.ts';
import { openProjectMenu, openNewProject } from '../projects.ts';
import { modelChip, modelInfo } from '../models.ts';
import { renderTeamChat } from '../teamchat.ts';
import type { Child } from '../core.ts';
import { teamSteps } from '../../shared/teams.ts';
import type { ActivityEntry, Agent, AppState, Chat, ChatItem, ChatSummary, Project, ProviderUsage, RunEvent, Schedule, ServerEvent, Team, TeamAccess, TeamListing, TeamMessage, TeamState, TeamStep, UsageMeter } from '../../shared/types.ts';

// ---------- types ----------
/** A connection a step can reach: a service, a program, an MCP server ('mcp:x') or a Claude account connector ('cc:x'). */
interface Integration {
  id: string;
  label: string;
  glyph: string;
  color: string;
  mcp?: boolean;
}
/** One entry of GET /api/programs. */
interface Program {
  id: string;
  name: string;
  category?: string;
  icon?: string;
  installed: boolean;
  optional?: boolean;
  exe: string | null;
  shortcut: string | null;
  version: string | null;
  versions?: string[] | null;
  cli: boolean;
  running: boolean;
  serviceUrl: string | null;
  actions?: unknown;
}
/** An integration this project has: is it up, and the program behind it. */
interface AvailableIntegration extends Integration {
  live: boolean;
  program?: Program;
  missing?: boolean;
}
/** A connector on your Claude account (GET /api/headbar). */
interface Connector {
  id: string;
  name: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'off';
  detail: string;
}
/** GET /api/headbar: usage meters and Claude account connectors. */
interface Headbar {
  usage?: unknown;
  usages: ProviderUsage[];
  connectors: Connector[];
}
/** GET /api/brain: a look inside the Brain folder. */
interface BrainInfo {
  project: Project;
  entries: { name: string; dir: boolean; path: string }[];
  files: number;
  sizeMB: number;
  git: { branch: string; remote: string; url: string; last: string; changes: number } | null;
  /** the description, or the first paragraph of PROJECT.md / README.md */
  summary?: { text: string; from: 'description' | 'PROJECT.md' | 'README.md' | null };
}
/** A workflow run (GET /api/workflow-runs, /api/workflow-active and the 'workflow-run' event). */
interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | string;
  steps: { status: string; label: string; agentId?: string | null }[];
  error?: string | null;
}
/** Where things sit on the map that isn't a team (GET /api/layout). */
interface StationLayout {
  bench?: { x: number; z: number } | null;
}
/** A team as the map draws it: members, and one agent step per member. */
/** A team as the map draws it: steps are one per member; stepList keeps its saved steps. */
type TeamView = TeamListing & { stepList?: TeamStep[] };

/** What a tool call means, in words, for the monitor. */
interface ToolDesc {
  app: string;
  action: string;
  detail: string;
  brand: string | null;
  color: string;
}
/** The arguments of a tool call, as describeTool reads them. */
interface ToolArgs {
  blend_file?: string;
  code?: string;
  file?: string;
  workflow?: string;
  prompt?: string;
  args?: string[];
  url?: string;
  query?: string;
  q?: string;
  text?: string;
  thread?: string[];
  to?: string;
  subreddit?: string;
  title?: string;
  post?: string;
  command?: string;
  file_path?: string;
  path?: string;
  pattern?: string;
  agent?: string;
  message?: string;
  profile?: string;
  program?: string;
  [k: string]: unknown;
}
/** What the desk's monitor shows while the agent works. */
type DeskAct = { kind: 'thinking' | 'writing'; since: number } | ({ kind: 'tool'; since: number } & ToolDesc);
type DeskStatus = 'idle' | 'working' | 'needs';
type RunStatus = 'running' | 'needs-you' | 'done' | 'failed';

interface CanvasTex {
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
type Ring = THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
/** Any scene object, as the clean-up walks it. */
type Disposable = THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
type MappedMaterial = THREE.Material & { map?: THREE.Texture | null };

/** An agent's desk: monitor, person, status orb and the ring when its team runs it. */
interface Desk {
  group: THREE.Group;
  agent: Agent;
  color: string;
  stepNo: string | number;
  screen: CanvasTex;
  screenGlow: THREE.Sprite;
  person: THREE.Group;
  orb: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  orbGlow: THREE.Sprite;
  ring: Ring;
  /** lights up when you hover a tile or engine this agent uses */
  focusRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  status: DeskStatus;
  activity: string;
  act?: DeskAct | null;
  lastDraw?: number;
  // set for desks in a team pod
  wfId?: string;
  branchAngle?: number;
  stepIndex?: number;
  podPos?: THREE.Vector3;
}

interface NodeBase {
  obj: THREE.Object3D;
  wfId: string | null;
  index: number;
  links: Set<string>;
  agentId?: string;
  pos?: THREE.Vector3;
  runStatus?: RunStatus | null;
}
/** An agent's desk on the map (in a pod, or on the Bench with wfId null). */
interface AgentNode extends NodeBase {
  kind: 'agent';
  desk: Desk;
  agentId: string;
}
/** An agent's desk in a team pod. */
interface PodNode extends AgentNode {
  wfId: string;
  pos: THREE.Vector3;
}
/** A tool or checkpoint on a pedestal (old step-list teams). */
interface PedestalNode extends NodeBase {
  kind: 'step';
  wfId: string;
  ring: Ring;
}
/** What S.nodes holds: everything on a team. */
type StationNode = PodNode | PedestalNode;
/** Anything a wire can run to: team nodes and Bench desks. */
type MapNode = StationNode | AgentNode;

/** A material whose opacity follows the team's activity. */
interface Rail {
  material: THREE.Material;
  base: number;
}
/** A team pod on the map. */
interface Branch {
  wf: TeamView;
  index: number;
  color: THREE.Color;
  group: THREE.Group;
  center: THREE.Vector3;
  radius: number;
  nodes: PodNode[];
  links: Set<string>;
  card: HTMLDivElement;
  agentCount: number;
  rails: Rail[];
  link: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  hub: { holo: THREE.Object3D; holo2: THREE.Object3D; hubGlow: THREE.Sprite };
  spin: number;
  flash: number;
  home: THREE.Vector3;
  along?: (t: number) => THREE.Vector3;
  moved?: boolean;
}
interface IntNode {
  it: AvailableIntegration;
  glow: THREE.Sprite;
  flash: number;
}
interface Curve {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  base: number;
  flash: number;
}
/** A light running along a path. */
interface ParticleSpec {
  parent?: THREE.Object3D;
  path: (t: number) => THREE.Vector3;
  t: number;
  speed: number;
  color: THREE.Color;
  size: number;
  loop: boolean;
  opacity?: number;
}
interface Particle extends ParticleSpec {
  sprite: THREE.Sprite;
}
type LabelKind = 'brain' | 'agent' | 'branch' | 'bench' | 'step' | 'int';
/** An HTML label that follows a 3D object. */
interface LabelSpec {
  kind: LabelKind;
  id: string;
  wf?: string;
  obj: THREE.Object3D;
  /** Cards pinned by an edge: the side away from this object. */
  from?: THREE.Object3D;
  offset: THREE.Vector3;
  el: HTMLElement;
}
interface Label extends LabelSpec {
  world: THREE.Vector3;
}
type PickType = 'agent' | 'branch' | 'bench' | 'brain' | 'int';
/** What a click on the map (or a label) points at. */
type MapPick =
  | { type: 'agent'; id: string; wf?: string; step?: number }
  | { type: 'branch' | 'int'; id: string; wf?: undefined; step?: number }
  | { type: 'bench' | 'brain'; id?: undefined; wf?: undefined; step?: undefined };
/** A dashed wire from a header tile to a desk. */
interface Link2d {
  intId: string;
  /** a wire to one desk (detailed), or null for a team's / the Bench's combined wire */
  node: MapNode | null;
  /** combined wire: where it ends (the team's hub or the Bench) and the desks it stands for */
  anchor?: THREE.Object3D;
  lift?: number;
  members?: MapNode[];
  flash: number;
}
/** A hovered team or agent: the connections it uses and the map nodes its wires run to. */
interface Hover {
  links: Set<string>;
  nodes: Set<MapNode>;
  /** from a header tile or an engine: the agents that use it (their desks and chips light up) */
  agents?: Set<string>;
  /** only the wires to these links stay lit (a tile lights its own wires, not all of each agent's) */
  only?: boolean;
  /** the Brain uses this engine */
  brain?: boolean;
  /** the colour to light desks with */
  color?: string;
}
interface WireDot {
  link: Link2d;
  t: number;
}
interface FeedItem {
  text: string;
  kind: string;
  ts: number;
}
/** The agent panel's mini chat. */
interface MiniChat {
  agentId: string;
  id: string | null;
  items: ChatItem[];
}
interface DropTarget {
  wfId?: string;
  bench?: boolean;
  at: THREE.Vector3;
  radius: number;
}
interface AgentDrag {
  desk: Desk;
  home: THREE.Vector3;
  marker: Ring;
  hint: HTMLDivElement;
  target: DropTarget | null;
  copy: boolean;
}
interface Cam {
  target: THREE.Vector3;
  az: number;
  el: number;
  zoom: number;
  view: number;
  goal: { target: THREE.Vector3; zoom: number } | null;
}
interface Brain {
  group: THREE.Group;
  cloud: THREE.Points;
  ico: THREE.LineSegments;
  halo: THREE.Sprite;
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  star: THREE.Sprite;
  light: THREE.PointLight;
  /** the project's logo, floating inside the globe */
  logo: THREE.Sprite | null;
  logoKey: string;
}
/** Everything the mounted Station holds. Null between mounts. */
interface StationState {
  root: HTMLDivElement;
  host: HTMLDivElement;
  labels: HTMLDivElement;
  hud: HTMLDivElement;
  panel: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  world: THREE.Group | null;
  desks: Desk[];
  nodes: StationNode[];
  branches: Map<string, Branch>;
  intNodes: Map<string, IntNode>;
  curves: Curve[];
  particles: Particle[];
  labelEls: Label[];
  progs: Program[];
  workflows: TeamView[];
  wfRuns: WorkflowRun[];
  active: Map<string, WorkflowRun>;
  signature: string;
  selected: MapPick | null;
  cam: Cam;
  feed: FeedItem[];
  clock: THREE.Clock;
  alive: boolean;
  chat: MiniChat | null;
  wires: SVGGElement | null;
  dots: WireDot[];
  links2dAll?: Link2d[];
  links2d: Link2d[];
  // filled in by render(), buildBrain(), setupControls(), resize() and loadData()
  wireDots: SVGGElement;
  brain: Brain;
  w: number;
  h: number;
  layout: StationLayout;
  teamState: Record<string, TeamState>;
  teamLast: Record<string, TeamMessage | null | undefined>;
  onKey: (e: KeyboardEvent) => void;
  onDocDown: (e: PointerEvent) => void;
  ro?: ResizeObserver;
  offState?: () => void;
  headTimer?: ReturnType<typeof setInterval>;
  clockTimer?: ReturnType<typeof setInterval>;
  usageTimer?: ReturnType<typeof setInterval>;
  progTimer?: ReturnType<typeof setInterval>;
  usageIdx?: number;
  headbar?: Headbar;
  /** What the pointer is over (a team or an agent): only its connections stay lit in the header. */
  hover?: Hover | null;
  /** the hover the chips and team cards were last marked for */
  hoverShown?: Hover | null;
  /** the side panel is sliding out */
  panelClosing?: Promise<void> | null;
  // the map
  benchCenter?: THREE.Vector3 | null;
  bench?: THREE.Group | null;
  benchNodes: AgentNode[];
  radius?: number;
  shape?: string | null;
  opened?: string;
  menu?: HTMLDivElement | null;
  agentDrag?: AgentDrag | null;
  // the HUD
  hudBuilt?: boolean;
  hudTop: HTMLDivElement;
  feedEl: HTMLDivElement;
  zoomEl: HTMLDivElement;
  emptyEl: HTMLDivElement;
  statsEl: HTMLDivElement;
  clockEl?: HTMLSpanElement;
  usageEl?: HTMLDivElement;
  tileEls: Map<string, HTMLButtonElement>;
  // the side panel
  teamTab?: string;
  chatEl?: HTMLDivElement;
  /** Files dragged over the map: 'map', or 'brain' when they are over the Brain (it glows). */
  fileDrag?: 'map' | 'brain' | null;
  dropHint?: HTMLDivElement | null;
  chatStatus?: HTMLDivElement;
  chatStream?: number | null;
}

// Live events the Station reads (ServerEvent with its fields).
type TeamEvent =
  | { kind: 'state'; working: string[]; queued: string[] }
  | { kind: 'message'; message: TeamMessage }
  | { kind: 'routed'; to: string[]; why: string }
  | { kind: 'turn'; agentId: string; state: 'start' | 'end' };
interface TeamServerEvent extends ServerEvent {
  type: 'team';
  teamId: string;
  event: TeamEvent;
}
interface WorkflowRunServerEvent extends ServerEvent {
  type: 'workflow-run';
  id: string;
  run?: WorkflowRun;
}
interface AgentRunServerEvent extends ServerEvent {
  type: 'run';
  runId: string;
  agentId: string;
  chatId: string;
  event: RunEvent;
}
interface ActivityServerEvent extends ServerEvent {
  type: 'activity';
  entry?: ActivityEntry;
}
type StationEvent = TeamServerEvent | WorkflowRunServerEvent | AgentRunServerEvent | ActivityServerEvent;
const isEvent = <T extends StationEvent['type']>(ev: ServerEvent, type: T): ev is Extract<StationEvent, { type: T }> => ev.type === type;

/** Globals the Station shares with the chat windows and the UI checks. */
type StationWindow = Window & {
  __stationDebug?: () => unknown;
  __chatsRestored?: boolean;
  __teams?: TeamView[];
  __teamWorking?: Record<string, string[]>;
};

/** S is set from render() until unmount(), and the map's helpers only run in between. Type-only: no check at runtime. */
function assertMounted(s: StationState | null): asserts s is StationState {}

export const flush = true;
export const station = true;
export const title = () => 'Station';

let S: StationState | null = null;
const PALETTE = ['#3d58c0', '#b0508a', '#c07a34', '#3a8a7a', '#7350c8', '#b8a03a', '#4f7fa8', '#5a9a3a', '#a84a5a', '#2f8fa0'];
const wfColor = (wf: Pick<Team, 'color'>, i: number): string => (/^#[0-9a-f]{6}$/i.test(wf.color || '') ? wf.color! : PALETTE[i % PALETTE.length]);

// ---------- connections ----------
const INTEGRATIONS: Integration[] = [
  { id: 'claude', label: 'Claude Code', glyph: '✳', color: '#d97757' },
  { id: 'hermes', label: 'Hermes', glyph: '☤', color: '#d8c25a' },
  { id: 'codex', label: 'OpenAI Codex', glyph: '◎', color: '#e6e8e0' },
  { id: 'reddit', label: 'Reddit', glyph: 'r/', color: '#ff4500' },
  { id: 'openrouter', label: 'OpenRouter', glyph: '⇄', color: '#8f94ff' },
  { id: 'lmstudio', label: 'LM Studio', glyph: 'LM', color: '#b48cff' },
  { id: 'ollama', label: 'Ollama', glyph: 'OL', color: '#e6e8e0' },
  { id: 'x', label: 'X', glyph: '𝕏', color: '#e6e8e0' },
  { id: 'telegram', label: 'Telegram', glyph: '✈', color: '#4fb3f6' },
  { id: 'discord', label: 'Discord', glyph: 'D', color: '#7d86ff' },
  { id: 'comfyui', label: 'ComfyUI', glyph: '🧩', color: '#ffd36e' },
  { id: 'blender', label: 'Blender', glyph: 'B', color: '#f5792a' },
  { id: 'premiere', label: 'Premiere Pro', glyph: 'Pr', color: '#9a9aff' },
  { id: 'photoshop', label: 'Photoshop', glyph: 'Ps', color: '#31a8ff' },
  { id: 'aftereffects', label: 'After Effects', glyph: 'Ae', color: '#d291ff' },
  { id: 'ffmpeg', label: 'FFmpeg', glyph: '▶', color: '#5fe3a0' },
  { id: 'orca', label: 'Orca', glyph: '🐋', color: '#7ab8ff' },
  { id: 'browser', label: 'Browser', glyph: '🌐', color: '#a9d3e2' },
];
const BRAND_OF: Record<string, string> = { codex: 'openai', reddit: 'reddit', claude: 'claude', x: 'x', telegram: 'telegram', discord: 'discord', blender: 'blender', premiere: 'premiere', photoshop: 'photoshop', aftereffects: 'aftereffects', ffmpeg: 'ffmpeg', browser: 'chrome', ollama: 'ollama' };
// The brand logo for an integration (or connector name), falling back to its glyph.
function mark(id: string, size = 14): SVGSVGElement | string {
  const key = id.startsWith('mcp:') ? id.slice(4) : id.startsWith('cc:') ? id.slice(3) : BRAND_OF[id] || id;
  return logo(key, size) || intInfo(id)?.glyph || String(key).slice(0, 2).toUpperCase();
}
const intInfo = (id: string): Integration | undefined => id.startsWith('cc:') ? { id, label: id.slice(3), glyph: connectorLook(id.slice(3)).glyph, color: connectorLook(id.slice(3)).color } : (id.startsWith('mcp:') ? { id, label: id.slice(4), glyph: '⌁', color: '#a9d3e2', mcp: true } : INTEGRATIONS.find((x) => x.id === id));

function availableIntegrations(d: AppState, progs: Program[]): AvailableIntegration[] {
  const P = (id: string) => progs.find((p) => p.id === id);
  const avail: Record<string, boolean> = {
    claude: d.engines['claude-code'].installed,
    hermes: d.engines.hermes.installed,
    codex: !!d.engines.codex?.installed,
    reddit: (d.accounts.reddit || []).length > 0,
    openrouter: d.secrets.openrouterKey.set,
    lmstudio: !!P('lmstudio')?.installed,
    ollama: !!P('ollama')?.installed,
    x: d.accounts.x.length > 0,
    telegram: d.accounts.telegram.configured,
    discord: d.accounts.discord.configured,
    browser: true,
  };
  for (const id of ['comfyui', 'blender', 'premiere', 'photoshop', 'aftereffects', 'ffmpeg', 'orca']) avail[id] = !!P(id)?.installed;
  const list = INTEGRATIONS.filter((i) => avail[i.id]).map((i): AvailableIntegration => {
    const p = P(i.id);
    const live = p ? (p.cli ? true : !!p.running) : true;
    return { ...i, live, program: p };
  });
  for (const m of d.mcpServers || []) list.push({ ...intInfo(`mcp:${m}`)!, live: true });
  return list;
}

/** What agentLinks reads: an agent, or a team's extra access. */
type LinkSource = Partial<Pick<Agent, 'engine' | 'claudeAuth' | 'provider' | 'toolGroups' | 'mcpServers'>>;
function agentLinks(a: LinkSource | null | undefined): Set<string> {
  const s = new Set<string>();
  if (!a) return s;
  if (a.engine === 'claude-code') s.add(a.claudeAuth === 'openrouter' ? 'openrouter' : 'claude');
  if (a.engine === 'hermes') s.add('hermes');
  if (a.engine === 'codex') s.add('codex');
  if (a.engine === 'openai') s.add(a.provider === 'custom' ? 'openrouter' : a.provider!);
  const g = new Set(a.toolGroups || []);
  if (g.has('social')) ['x', 'reddit', 'telegram', 'discord'].forEach((x) => s.add(x));
  if (g.has('comfyui')) s.add('comfyui');
  if (g.has('blender')) s.add('blender');
  if (g.has('adobe')) ['premiere', 'photoshop', 'aftereffects'].forEach((x) => s.add(x));
  if (g.has('media')) s.add('ffmpeg');
  if (g.has('orca')) s.add('orca');
  if (g.has('browser')) s.add('browser');
  for (const m of a.mcpServers || []) s.add(`mcp:${m}`);
  if (a.engine === 'claude-code' && (a.claudeAuth || 'login') === 'login') for (const c of S?.headbar?.connectors || []) if (c.status === 'connected') s.add(`cc:${c.name}`);
  return s;
}

function toolIntegration(name: unknown): string | null {
  const n = String(name || '');
  const map: [RegExp, string][] = [
    [/^blender_/, 'blender'],
    [/^comfyui_/, 'comfyui'],
    [/^photoshop_/, 'photoshop'],
    [/^aftereffects_/, 'aftereffects'],
    [/^premiere_/, 'premiere'],
    [/^ff(mpeg|probe)$/, 'ffmpeg'],
    [/^(x_|social_)/, 'x'],
    [/^telegram_/, 'telegram'],
    [/^reddit_/, 'reddit'],
    [/^discord_/, 'discord'],
    [/^orca$/, 'orca'],
    [/^hermes_ask$/, 'hermes'],
    [/^(open_url|fetch_url|WebFetch|WebSearch)$/, 'browser'],
  ];
  for (const [re, id] of map) if (re.test(n)) return id;
  const m = /^mcp__(.+?)__/.exec(n);
  if (m && /^claude_ai_/.test(m[1])) {
    const name = m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ').toLowerCase();
    const c = (S?.headbar?.connectors || []).find((x) => x.name.toLowerCase() === name);
    if (c) return `cc:${c.name}`;
  }
  if (m) return `mcp:${m[1]}`;
  const srv = (state.data?.mcpServers || []).find((s) => n.startsWith(`${s}__`));
  if (srv) return `mcp:${srv}`;
  if (/^(Bash|Read|Write|Edit|Glob|Grep|Task|ToolSearch)$/.test(n)) return 'claude';
  return null;
}

// What a workflow step can reach.
function stepLinks(step: TeamStep, agentsById: Map<string, Agent>, wf: TeamView | null = null): Set<string> {
  if (step.type === 'agent') {
    const links = agentLinks(agentsById.get(step.agentId!));
    if (wf?.access) agentLinks({ toolGroups: wf.access.toolGroups, mcpServers: wf.access.mcpServers }).forEach((l) => links.add(l));
    return links;
  }
  if (step.type === 'tool') {
    const i = toolIntegration(step.tool);
    return new Set<string>(i ? [i] : []);
  }
  if (step.type === 'x_post') return new Set(['x']);
  if (step.type === 'notify' && step.telegram) return new Set(['telegram']);
  return new Set<string>();
}

const STEP_LOOK: Record<string, { glyph: string; label: string; color: string }> = {
  tool: { glyph: '⚙', label: 'Tool', color: '#a9d3e2' },
  approval: { glyph: '✋', label: 'Your OK', color: '#f0b04a' },
  x_post: { glyph: '𝕏', label: 'Post to X', color: '#e6e8e0' },
  notify: { glyph: '✉', label: 'Notify you', color: '#5fe3a0' },
};

// ---------- textures ----------
function canvasTex(w: number, hgt: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTex {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, hgt);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, canvas: c, ctx };
}

let glowTex: THREE.CanvasTexture | null = null;
function glow(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  glowTex = canvasTex(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }).tex;
  return glowTex;
}

const glyphCache = new Map<string, THREE.Texture>();
function glyphTex(glyph: string, color: string): THREE.Texture {
  const key = glyph + color;
  if (glyphCache.has(key)) return glyphCache.get(key)!;
  const t = canvasTex(128, 128, (ctx) => {
    ctx.fillStyle = '#0d100d';
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = color;
    const emoji = /\p{Extended_Pictographic}/u.test(glyph);
    ctx.font = `bold ${glyph.length > 1 && !emoji ? 46 : 58}px "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 64, 68);
  }).tex;
  glyphCache.set(key, t);
  return t;
}

// What a tool call means, in words, for the monitor: { app, action, detail, brand, color }.
function describeTool(name: unknown, args: ToolArgs = {}): ToolDesc {
  const n = String(name || '');
  const host = (u: string | undefined) => {
    try {
      return new URL(u as string).hostname.replace(/^www\./, '');
    } catch {
      return String(u || '').slice(0, 40);
    }
  };
  const base = (p: unknown) => String(p || '').split(/[\\/]/).pop();
  const A = (app: string, action: string, detail: unknown = '', brand: string | null = null, color = '#c4ff3d'): ToolDesc => ({ app, action, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 60), brand, color });
  if (n === 'blender_run_python') return A('Blender', 'running a script', base(args.blend_file) || (args.code || '').split('\n').find((l) => l.trim() && !l.startsWith('import')) || '', 'blender', '#f5792a');
  if (n === 'blender_open') return A('Blender', 'opening', base(args.file), 'blender', '#f5792a');
  if (n.startsWith('comfyui_')) return A('ComfyUI', n === 'comfyui_run' ? `rendering ${args.workflow || ''}` : n.replace('comfyui_', '').replace(/_/g, ' '), args.prompt || '', null, '#ffd36e');
  if (n === 'ffmpeg') return A('FFmpeg', 'processing video', base((args.args || []).at(-1)), 'ffmpeg', '#5fe3a0');
  if (n === 'ffprobe') return A('FFmpeg', 'inspecting', base(args.file), 'ffmpeg', '#5fe3a0');
  if (n === 'photoshop_run_script') return A('Photoshop', 'running a script', '', 'photoshop', '#31a8ff');
  if (n === 'aftereffects_run_script') return A('After Effects', 'running a script', '', 'aftereffects', '#d291ff');
  if (n === 'premiere_open') return A('Premiere Pro', 'opening', base(args.file), 'premiere', '#9a9aff');
  if (n === 'fetch_url' || n === 'WebFetch') return A('Browser', 'reading', host(args.url), 'chrome', '#a9d3e2');
  if (n === 'open_url') return A('Browser', 'opening', host(args.url), 'chrome', '#a9d3e2');
  if (n === 'WebSearch') return A('Web search', 'searching', args.query || '', 'chrome', '#a9d3e2');
  if (n === 'x_draft_post') return A('X', 'drafting a post', args.text || (args.thread || [])[0] || '', 'x', '#e6e8e0');
  if (n === 'x_draft_dm') return A('X', `drafting a DM to @${String(args.to || '').replace(/^@/, '')}`, args.text || '', 'x', '#e6e8e0');
  if (n === 'x_recent_posts' || n === 'x_mentions') return A('X', 'reading', n === 'x_mentions' ? 'mentions' : 'recent posts', 'x', '#e6e8e0');
  if (n === 'telegram_send') return A('Telegram', 'sending a message', args.text || '', 'telegram', '#4fb3f6');
  if (n === 'reddit_draft_post') return A('Reddit', `drafting a post for r/${String(args.subreddit || '').replace(/^\/?r\//, '')}`, args.title || '', 'reddit', '#ff4500');
  if (n === 'reddit_draft_comment') return A('Reddit', 'drafting a comment', args.text || '', 'reddit', '#ff4500');
  if (n === 'reddit_read' || n === 'reddit_search' || n === 'reddit_comments') return A('Reddit', n === 'reddit_search' ? 'searching' : 'reading', args.subreddit ? `r/${args.subreddit}` : args.query || args.post || '', 'reddit', '#ff4500');
  if (n === 'discord_send') return A('Discord', 'posting', args.text || '', 'discord', '#7d86ff');
  if (n === 'Bash' || n === 'run_command') return A('Terminal', 'running', args.command || '', null, '#c4ff3d');
  if (['Read', 'read_file', 'knowledge_read'].includes(n)) return A('Files', 'reading', base(args.file_path || args.path || args.file), null, '#a9d3e2');
  if (['Write', 'Edit', 'write_file', 'NotebookEdit'].includes(n)) return A('Files', 'writing', base(args.file_path || args.path), null, '#a9d3e2');
  if (['Glob', 'Grep', 'list_files', 'knowledge_search'].includes(n)) return A('Files', 'searching', args.pattern || args.query || args.path || '', null, '#a9d3e2');
  if (n === 'ask_agent') return A('Team', `asking ${args.agent || 'a teammate'}`, args.message || '', null, '#c4ff3d');
  if (n === 'hermes_ask') return A('Hermes', `asking ${args.profile || 'Hermes'}`, args.message || '', null, '#d8c25a');
  if (n === 'launch_program') return A(String(args.program || 'Program'), 'starting', base(args.file), String(args.program || '').toLowerCase(), '#c4ff3d');
  if (n === 'orca') return A('Orca', (args.args || []).join(' '), '', null, '#7ab8ff');
  const m = /^mcp__(.+?)__(.+)$/.exec(n) || /^(.+?)__(.+)$/.exec(n);
  if (m) {
    const server = m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return A(server.replace(/\b\w/g, (c) => c.toUpperCase()), m[2].replace(/[_-]/g, ' ').slice(0, 40), args.url ? host(args.url) : args.query || args.q || '', server.toLowerCase(), '#a9d3e2');
  }
  return A(n.replace(/_/g, ' '), 'working', '', null, '#c4ff3d');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: unknown, max: number): string {
  let t = String(text || '');
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

// The little monitor on each desk.
function drawScreen(desk: Desk, tick = 0): void {
  const { ctx, canvas } = desk.screen;
  const W = canvas.width;
  const H = canvas.height;
  const st = desk.status;
  const a = desk.agent;
  const act = desk.act;
  ctx.textBaseline = 'middle';
  if (st === 'idle') {
    ctx.fillStyle = '#e4e8dd';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#cdd2c6';
    ctx.fillRect(0, 0, W, 40);
    ['#ff6b6b', '#f0b04a', '#5fe3a0'].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(24 + i * 24, 20, 7, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#3a3f37';
    ctx.font = 'bold 20px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(desk.stepNo && desk.stepNo !== '-' ? String(desk.stepNo) : 'BENCH', W - 20, 21);
    ctx.textAlign = 'left';
    ctx.font = '84px "Segoe UI Emoji", sans-serif';
    ctx.fillText(a.emoji || '🤖', 28, 140);
    ctx.fillStyle = '#16190f';
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.fillText(fitText(ctx, a.name, W - 160), 140, 118);
    ctx.fillStyle = '#5f6559';
    ctx.font = '26px Consolas, monospace';
    ctx.fillText(fitText(ctx, `○ ready · ${shortModel(a)}`, W - 160), 140, 162);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i === 0 ? desk.color : '#c3c8bc';
      roundRect(ctx, 28, 214 + i * 24, 80 + ((i * 97) % 300), 10, 5);
      ctx.fill();
    }
  } else if (st === 'needs') {
    ctx.fillStyle = '#21180a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = Math.sin(tick * 6) > 0 ? '#f0b04a' : '#7a5a24';
    ctx.font = 'bold 120px "Segoe UI Symbol", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', 90, H / 2 + 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0b04a';
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.fillText('Waiting for you', 170, 120);
    ctx.fillStyle = '#e6e8e0';
    ctx.font = '24px "Segoe UI", sans-serif';
    const ap = (state.data?.approvals || []).find((x) => x.agentId === a.id);
    ctx.fillText(fitText(ctx, (ap?.title || 'needs your OK').replace(`${a.name} wants to `, ''), W - 190), 170, 168);
    ctx.fillStyle = '#9a8a6a';
    ctx.font = '22px Consolas, monospace';
    ctx.fillText('open Needs you to answer', 170, 214);
  } else {
    // working
    ctx.fillStyle = '#0b130a';
    ctx.fillRect(0, 0, W, H);
    const isTool = act?.kind === 'tool';
    const color = isTool ? act.color : '#c4ff3d';
    // logo disc
    const cx = 86;
    const cy = 150;
    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, 90);
    g.addColorStop(0, color + '55');
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 50, 200, 200);
    ctx.fillStyle = '#121a11';
    ctx.beginPath();
    ctx.arc(cx, cy, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 54, -Math.PI / 2 + tick * 3, -Math.PI / 2 + tick * 3 + Math.PI * 1.4);
    ctx.stroke();
    const bp = isTool && act.brand ? brandPath(act.brand) : null;
    if (bp) {
      ctx.save();
      ctx.translate(cx - 30, cy - 30);
      ctx.scale(2.5, 2.5);
      ctx.fillStyle = bp.hex;
      ctx.fill(new Path2D(bp.d));
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = isTool ? 'bold 44px "Segoe UI", sans-serif' : '56px "Segoe UI Emoji", sans-serif';
      ctx.fillText(isTool ? act.app.slice(0, 2).toUpperCase() : a.emoji || '🤖', cx, cy + 3);
      ctx.textAlign = 'left';
    }
    // words
    ctx.fillStyle = '#e6e8e0';
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.fillText(fitText(ctx, isTool ? act.app : act?.kind === 'writing' ? 'Writing reply' : 'Thinking', W - 190), 170, 104);
    ctx.fillStyle = color;
    ctx.font = '28px "Segoe UI", sans-serif';
    const dots = '.'.repeat(1 + (Math.floor(tick * 2) % 3));
    ctx.fillText(fitText(ctx, isTool ? act.action : `${dots}`, W - 190), 170, 150);
    if (isTool && act.detail) {
      ctx.fillStyle = '#8f968a';
      ctx.font = '22px Consolas, monospace';
      ctx.fillText(fitText(ctx, act.detail, W - 190), 170, 192);
    }
    // bottom: moving progress + time
    ctx.fillStyle = '#1c2a18';
    roundRect(ctx, 28, 262, W - 160, 10, 5);
    ctx.fill();
    const pw = 120;
    const px = 28 + ((tick * 160) % (W - 160 + pw)) - pw;
    ctx.save();
    roundRect(ctx, 28, 262, W - 160, 10, 5);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(px, 262, pw, 10);
    ctx.restore();
    const secs = act?.since ? Math.max(0, Math.round((Date.now() - act.since) / 1000)) : 0;
    ctx.fillStyle = '#8f968a';
    ctx.font = 'bold 22px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}` : `${secs}s`, W - 22, 268);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5a6455';
    ctx.font = 'bold 18px Consolas, monospace';
    ctx.fillText(fitText(ctx, `${a.name.toUpperCase()} · ${shortModel(a)}`, W - 60), 28, 26);
  }
  desk.screen.tex.needsUpdate = true;
}

// ---------- mount ----------
export async function render(el: HTMLElement): Promise<void> {
  const root = h('div.st-root');
  const host = h('div.st-canvas');
  const labels = h('div.st-labels');
  const hud = h('div.st-hud');
  const panel = h('aside.st-panel.hidden');
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.classList.add('st-wires');
  const wireDots = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  wires.append(wireDots);
  root.append(host, wires, labels, hud, panel);
  mount(el, root);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x070807, 1);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -600, 1200);
  scene.add(new THREE.AmbientLight(0xbfc8ff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x7fb6ff, 0.35);
  rim.position.set(-40, 20, -30);
  scene.add(rim);
  {
    const pts: number[] = [];
    for (let x = -150; x <= 150; x += 3) for (let z = -150; z <= 150; z += 3) pts.push(x, -0.01, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x262b24, size: 2, sizeAttenuation: false })));
  }

  S = {
    root,
    host,
    labels,
    hud,
    panel,
    renderer,
    scene,
    camera,
    world: null,
    desks: [],
    nodes: [],
    branches: new Map(),
    intNodes: new Map(),
    curves: [],
    particles: [],
    labelEls: [],
    progs: [],
    workflows: [],
    wfRuns: [],
    active: new Map(),
    signature: '',
    selected: null,
    cam: { target: new THREE.Vector3(), az: Math.PI / 4, el: Math.atan(1 / Math.SQRT2), zoom: 1, view: 70, goal: null },
    feed: [],
    clock: new THREE.Clock(),
    alive: true,
    chat: null,
    wires: null,
    dots: [],
    links2d: [],
  } as Partial<StationState> as StationState; // the rest is filled in below
  S.wireDots = wireDots;
  S.wires = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  wires.append(S.wires);
  buildBrain();
  setupControls();
  S.ro = new ResizeObserver(resize);
  S.ro.observe(root);
  resize();

  await loadData();
  if (!S) return;
  rebuild();
  drawHud();
  resetView(true);
  S.offState = onState(() => {
    if (!S) return;
    if (signature() !== S.signature) rebuild();
    else updateStatuses();
    drawHud();
    if (S.selected && S.selected.type !== 'agent' && S.selected.type !== 'branch') renderPanel();
  });
  const feed = await GET<ActivityEntry[]>('/activity').catch((): ActivityEntry[] => []);
  if (S) {
    S.feed = feed.slice(0, 4).map((a) => ({ text: a.text, kind: a.kind, ts: a.ts }));
    drawFeed();
  }
  loadHeadbar();
  S.headTimer = setInterval(loadHeadbar, 60_000);
  S.clockTimer = setInterval(tickClock, 1000);
  // usage of each connected provider, one after another
  S.usageTimer = setInterval(() => {
    if ((S?.headbar?.usages?.length || 0) > 1) {
      S!.usageIdx = (S!.usageIdx || 0) + 1;
      drawUsage(true);
    }
  }, 6000);
  S.progTimer = setInterval(async () => {
    const p = await GET<Program[]>('/programs').catch(() => null);
    if (S && p) {
      S.progs = p;
      if (signature() !== S.signature) rebuild();
      drawHud();
    }
  }, 30000);
  loop();
  // read-only: where teams and desks are on screen (used by the automated UI checks)
  (window as StationWindow).__stationDebug = () => {
    if (!S) return null;
    const at = (o: THREE.Object3D) => {
      const p = o.getWorldPosition(new THREE.Vector3()).project(S!.camera);
      const r = S!.renderer.domElement.getBoundingClientRect();
      return { x: Math.round(r.left + ((p.x + 1) / 2) * r.width), y: Math.round(r.top + ((1 - p.y) / 2) * r.height) };
    };
    return [...S.branches.values()].map((b) => ({ name: b.wf.name, ...at(b.group), desks: b.nodes.map((n) => ({ name: n.desk.agent.name, ...at(n.desk.group) })) }));
  };
}

// A team's members, as the desk list the map draws.
function teamView(w: TeamListing): TeamView {
  const members = Array.isArray(w.members) ? w.members : [...new Set((w.steps || []).filter((x) => x.type === 'agent' && x.agentId).map((x) => x.agentId!))];
  return { ...w, members, steps: members.map((id) => ({ type: 'agent', agentId: id })), stepList: w.steps || [] };
}

async function loadData(): Promise<void> {
  const [progs, wfs, runs, active, layout] = await Promise.all([GET<Program[]>('/programs').catch((): Program[] => []), GET<TeamListing[]>('/workflows').catch((): TeamListing[] => []), GET<WorkflowRun[]>('/workflow-runs').catch((): WorkflowRun[] => []), GET<WorkflowRun[]>('/workflow-active').catch((): WorkflowRun[] => []), GET<StationLayout>('/layout').catch((): StationLayout => ({}))]);
  if (!S) return;
  S.layout = layout || {};
  S.progs = progs;
  S.workflows = wfs.map(teamView);
  S.teamState = Object.fromEntries(wfs.map((w) => [w.id, w.state || { working: [], queued: [] }]));
  S.teamLast = Object.fromEntries(wfs.filter((w) => w.last).map((w) => [w.id, w.last]));
  S.wfRuns = runs;
  S.active = new Map(active.map((r) => [r.workflowId, r]));
  shareTeams();
  if (!(window as StationWindow).__chatsRestored) {
    (window as StationWindow).__chatsRestored = true;
    restoreChats();
  }
}

function shareTeams(): void {
  assertMounted(S);
  (window as StationWindow).__teams = S.workflows;
  (window as StationWindow).__teamWorking = Object.fromEntries(Object.entries(S.teamState || {}).map(([k, v]) => [k, v.working || []]));
  refreshChatTabs();
}

export function unmount(): void {
  if (!S) return;
  S.alive = false;
  S.offState?.();
  S.ro?.disconnect();
  clearInterval(S.progTimer);
  clearInterval(S.headTimer);
  clearInterval(S.clockTimer);
  clearInterval(S.usageTimer);
  window.removeEventListener('keydown', S.onKey);
  document.removeEventListener('pointerdown', S.onDocDown, true);
  S.renderer.dispose();
  S.scene.traverse((o: Disposable) => {
    o.geometry?.dispose?.();
    if (o.material) ([] as THREE.Material[]).concat(o.material).forEach((m) => m.dispose?.());
  });
  S = null;
}

function resize(): void {
  if (!S) return;
  const r = S.root.getBoundingClientRect();
  S.w = Math.max(1, r.width);
  S.h = Math.max(1, r.height);
  S.renderer.setSize(S.w, S.h, false);
  S.renderer.domElement.style.width = `${S.w}px`;
  S.renderer.domElement.style.height = `${S.h}px`;
  updateCamera();
}

function updateCamera(): void {
  assertMounted(S);
  const c = S.cam;
  const aspect = S.w / S.h;
  const v = c.view / c.zoom;
  Object.assign(S.camera, { left: (-v * aspect) / 2, right: (v * aspect) / 2, top: v / 2, bottom: -v / 2 });
  const D = 300;
  S.camera.position.set(c.target.x + Math.sin(c.az) * Math.cos(c.el) * D, c.target.y + Math.sin(c.el) * D, c.target.z + Math.cos(c.az) * Math.cos(c.el) * D);
  S.camera.lookAt(c.target);
  S.camera.updateProjectionMatrix();
  for (const d of S.desks) d.group.rotation.y = c.az + (d.branchAngle || 0);
}

function signature(): string {
  assertMounted(S);
  const d = state.data;
  if (!d) return '';
  const ints = availableIntegrations(d, S.progs).map((i) => `${i.id}${i.live ? '+' : ''}`).join(',');
  return JSON.stringify([
    S.workflows.map((w) => [w.id, w.name, w.color, w.angle, w.pos, w.rot, w.access, w.lead, w.members]),
    d.agents.map((a) => [a.id, a.name, a.emoji, a.color, a.model, a.engine, [...agentLinks(a)].join('|')]),
    ints,
  ]);
}

// ---------- the Brain ----------
function buildBrain(): void {
  assertMounted(S);
  const g = new THREE.Group();
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.4, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x121612, roughness: 0.8, metalness: 0.3 }));
  ped.position.y = 0.4;
  g.add(ped);
  const pedEdges = new THREE.LineSegments(new THREE.EdgesGeometry(ped.geometry), new THREE.LineBasicMaterial({ color: 0x7a9a2c, transparent: true, opacity: 0.6 }));
  pedEdges.position.copy(ped.position);
  g.add(pedEdges);
  const N = 2200;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c1 = new THREE.Color(0x7fb6ff);
  const c2 = new THREE.Color(0xe6f2ff);
  for (let i = 0; i < N; i++) {
    const r = 2.6 * Math.pow(Math.random(), 0.35);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.8, r * Math.sin(ph) * Math.sin(th)], i * 3);
    const c = c1.clone().lerp(c2, Math.random());
    col.set([c.r, c.g, c.b], i * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const cloud = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  cloud.position.y = 3.2;
  g.add(cloud);
  const ico = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.1, 1)), new THREE.LineBasicMaterial({ color: 0xc4ff3d, transparent: true, opacity: 0.18 }));
  ico.position.y = 3.2;
  g.add(ico);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: 0x6fa8ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.set(11, 11, 1);
  halo.position.y = 3.2;
  g.add(halo);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.7, 16, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd36e, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  beam.position.y = 12;
  g.add(beam);
  const star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: 0xffcc55, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  star.scale.set(6, 6, 1);
  star.position.y = 7.4;
  g.add(star);
  const light = new THREE.PointLight(0x9fd0ff, 30, 40, 1.6);
  light.position.y = 4;
  g.add(light);
  g.traverse((o) => (o.userData.pick = { type: 'brain' }));
  S.scene.add(g);
  S.brain = { group: g, cloud, ico, halo, beam, star, light, logo: null, logoKey: '' };
  setBrainLogo();
}

// Put the project's logo inside the globe (or take it out). It always faces you and gently floats,
// while the globe and its particles turn around it. Cheap to call often: nothing happens unless it changed.
function setBrainLogo(): void {
  const b = S?.brain;
  if (!b) return;
  const url = logoUrl(state.data?.project) || '';
  if (url === b.logoKey) return;
  b.logoKey = url;
  if (b.logo) {
    b.group.remove(b.logo);
    b.logo.material.map?.dispose();
    b.logo.material.dispose();
    b.logo = null;
  }
  if (!url) return;
  new THREE.TextureLoader().load(url, (tex) => {
    if (!S?.brain || S.brain.logoKey !== url) return tex.dispose();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const img = tex.image as { width: number; height: number };
    const aspect = img.width && img.height ? img.width / img.height : 1;
    const side = 3.1;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.96 }));
    sp.scale.set(aspect >= 1 ? side : side * aspect, aspect >= 1 ? side / aspect : side, 1);
    sp.position.y = 3.2;
    sp.renderOrder = 5;
    sp.userData.pick = { type: 'brain' };
    sp.userData.base = sp.scale.clone();
    S.brain.group.add(sp);
    S.brain.logo = sp;
  });
}

// ---------- layout ----------
const STEP_GAP = 8;
const FIRST = 14;

function rebuild(): void {
  const d = state.data;
  if (!d || !S) return;
  S.signature = signature();
  if (S.world) {
    S.scene.remove(S.world);
    S.world.traverse((o: Disposable) => {
      o.geometry?.dispose?.();
      if (o.material) ([] as MappedMaterial[]).concat(o.material).forEach((m) => (m.map && m.map !== glowTex && ![...glyphCache.values()].includes(m.map) && m.map.dispose?.(), m.dispose?.()));
    });
  }
  for (const l of S.labelEls) l.el.remove();
  Object.assign(S, { labelEls: [], desks: [], nodes: [], curves: [], particles: [] });
  S.branches.clear();
  S.benchCenter = null;
  S.bench = null;
  S.benchNodes = [];
  S.intNodes.clear();
  const world = new THREE.Group();
  S.world = world;
  S.scene.add(world);

  const agentsById = new Map(d.agents.map((a) => [a.id, a]));
  const wfs = S.workflows;
  const used = new Set(wfs.flatMap((w) => w.steps.filter((s) => s.type === 'agent').map((s) => s.agentId)));
  const bench = d.agents.filter((a) => !used.has(a.id));
  // Branches spread around the Brain, leaving the front open for the Bench.
  const n = wfs.length;
  const gap = bench.length ? 0.9 : 0;
  // Without a Bench, start on a world axis so branches run diagonally on screen (isometric look).
  const front = gap ? Math.PI / 4 : 0;
  let maxR = FIRST;
  const biggest = Math.max(5, ...wfs.map((w) => podRadius((w.members || []).length)));
  const dist = Math.max(FIRST + biggest, n > 1 ? (biggest + 2.5) / Math.sin(Math.PI / Math.max(2, n + (gap ? 1 : 0))) : 0);
  wfs.forEach((wf, i) => {
    const ang = front + gap / 2 + (n === 1 ? (Math.PI * 2 - gap) / 2 : (i / Math.max(1, n - (gap ? 1 : 0))) * (Math.PI * 2 - gap));
    const end = buildBranch(wf, i, typeof wf.angle === 'number' ? wf.angle : ang, agentsById, dist);
    maxR = Math.max(maxR, end);
  });
  if (bench.length) buildBench(bench);
  S.radius = maxR;

  // Wires from the header tiles down to every step that can use that connection (drawn in 2D, see drawWires).
  buildWires();

  addLabel({
    kind: 'brain',
    id: 'brain',
    obj: S.brain.group,
    offset: new THREE.Vector3(0, 9.5, 0),
    el: h('div.st-brain-label', { onclick: () => choose({ type: 'brain' }), title: 'Click for the project Brain · drop files here to give them to it', ondragenter: brainDragOver, ondragover: brainDragOver, ondrop: brainDrop }, icon('brain', 14), 'THE BRAIN', h('span.st-brain-n', `${d.project?.name || ''} · ${wfs.length} team${wfs.length === 1 ? '' : 's'} · ${d.agents.length} agent${d.agents.length === 1 ? '' : 's'}`)),
  });
  // A branch added or removed: make sure the whole station still fits.
  const shape = `${wfs.length}:${bench.length}`;
  if (S.shape && S.shape !== shape) fitView();
  S.shape = shape;
  updateCamera();
  updateStatuses();
  // #/station?team=<id> opens that team (e.g. "Show" in the Brain chat)
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('team');
  if (want && S.opened !== want && wfs.some((w) => w.id === want)) {
    S.opened = want;
    return choose({ type: 'branch', id: want });
  }
  if (S.selected) renderPanel();
}

// A team is a group chat, so it's drawn as a round pod: the agents sit around a shared chat hub,
// the lead's desk faces the Brain (★), spokes join every desk to the hub, and handoffs fly
// desk → hub → desk. Teams can sit anywhere (drag) and spin (Shift+drag); wf.pos / wf.rot keep it.
const podRadius = (n: number): number => Math.max(6, (Math.max(1, n) * 5.6) / (2 * Math.PI) + 3.4);

function buildBranch(wf: TeamView, i: number, ang: number, agentsById: Map<string, Agent>, dist: number): number {
  assertMounted(S);
  const color = new THREE.Color(wfColor(wf, i));
  const light = color.clone().lerp(new THREE.Color(0xffffff), 0.4);
  const members = (wf.members || []).filter((id) => agentsById.get(id));
  const R = podRadius(members.length);
  const pod = new THREE.Group();
  const home = new THREE.Vector3(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
  pod.position.copy(wf.pos && Number.isFinite(wf.pos.x) && Number.isFinite(wf.pos.z) ? new THREE.Vector3(wf.pos.x, 0, wf.pos.z) : home);
  const spin = typeof wf.rot === 'number' ? wf.rot : 0;
  pod.rotation.y = -spin;
  S.world!.add(pod);
  pod.updateMatrixWorld(true);

  // the round floor
  const floor = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(R, R + 0.25, 0.5, 64), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.42), roughness: 0.55, metalness: 0.15, emissive: color, emissiveIntensity: 0.1 }));
  slab.position.y = 0.25;
  floor.add(slab);
  const top = new THREE.Mesh(new THREE.CircleGeometry(R - 0.15, 64), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.62), roughness: 0.75, emissive: color, emissiveIntensity: 0.07 }));
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.51;
  floor.add(top);
  const rim = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry, 30), new THREE.LineBasicMaterial({ color: light, transparent: true, opacity: 0.7 }));
  rim.position.copy(slab.position);
  floor.add(rim);
  // an inner ring where the conversation runs
  const track = new THREE.Mesh(new THREE.RingGeometry(R * 0.42, R * 0.42 + 0.08, 64), new THREE.MeshBasicMaterial({ color: light, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  track.rotation.x = -Math.PI / 2;
  track.position.y = 0.53;
  floor.add(track);
  const under = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }));
  under.scale.set(R * 3, R * 2.2, 1);
  under.position.y = -0.2;
  floor.add(under);
  floor.traverse((o) => (o.userData.pick = { type: 'branch', id: wf.id }));
  pod.add(floor);

  // the chat hub in the middle: everyone talks through it
  const hub = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.2, 0.55, 6), new THREE.MeshStandardMaterial({ color: 0x141714, roughness: 0.5, metalness: 0.3, emissive: color, emissiveIntensity: 0.35 }));
  base.position.y = 0.8;
  hub.add(base);
  const holo = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.05, 8, 48), new THREE.MeshBasicMaterial({ color: light, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  holo.rotation.x = Math.PI / 2;
  holo.position.y = 2.1;
  hub.add(holo);
  const holo2 = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.04, 8, 40), holo.material.clone());
  holo2.position.y = 2.1;
  hub.add(holo2);
  const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyphTex('@', '#' + light.getHexString()), transparent: true, depthWrite: false }));
  mark.scale.set(1.3, 1.3, 1);
  mark.position.y = 2.1;
  hub.add(mark);
  const hubGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
  hubGlow.scale.set(4.5, 4.5, 1);
  hubGlow.position.y = 1.8;
  hub.add(hubGlow);
  hub.traverse((o) => (o.userData.pick = { type: 'branch', id: wf.id }));
  pod.add(hub);
  const HUB = new THREE.Vector3(0, 1.7, 0);

  // where the Brain is, seen from the pod: the lead sits on that side
  const toBrain = pod.worldToLocal(new THREE.Vector3(0, 0, 0)).setY(0);
  const baseAng = toBrain.lengthSq() > 0.01 ? Math.atan2(toBrain.z, toBrain.x) : 0;
  const order = wf.lead && members.includes(wf.lead) ? [wf.lead, ...members.filter((id) => id !== wf.lead)] : members;
  const rails: Rail[] = [{ material: track.material, base: 0.35 }];
  const branchNodes: PodNode[] = [];
  const branchLinks = new Set<string>();
  order.forEach((agentId, k) => {
    const agent = agentsById.get(agentId)!;
    const a = baseAng + (k / Math.max(1, order.length)) * Math.PI * 2;
    const pos = new THREE.Vector3(Math.cos(a) * (R - 1.55), 0, Math.sin(a) * (R - 1.55));
    const isLead = wf.lead === agentId;
    const step: TeamStep = { type: 'agent', agentId };
    const links = stepLinks(step, agentsById, wf);
    links.forEach((l) => branchLinks.add(l));
    const desk = makeDesk(agent, wfColor(wf, i), isLead ? 'LEAD' : 'TEAM');
    desk.group.position.copy(pos).setY(0.5);
    desk.group.traverse((o) => (o.userData.pick = { type: 'agent', id: agent.id, wf: wf.id, step: k }));
    pod.add(desk.group);
    Object.assign(desk, { wfId: wf.id, branchAngle: spin, stepIndex: k, podPos: pos.clone() });
    S!.desks.push(desk);
    // the lead's seat gets a gold ring
    if (isLead) {
      const seat = new THREE.Mesh(new THREE.RingGeometry(1.75, 1.95, 48), new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.75, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      seat.rotation.x = -Math.PI / 2;
      seat.position.copy(pos).setY(0.56);
      pod.add(seat);
    }
    // spoke from the desk to the hub
    const spoke = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([pos.clone().setY(0.6), HUB.clone().setY(0.6)]),
      new THREE.LineBasicMaterial({ color: light, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    pod.add(spoke);
    rails.push({ material: spoke.material, base: 0.3 });
    const node: PodNode = { kind: 'agent', pos, obj: desk.group, wfId: wf.id, index: k, links, desk, agentId: agent.id };
    S!.nodes.push(node);
    branchNodes.push(node);
    addLabel({
      kind: 'agent',
      id: agent.id,
      wf: wf.id,
      obj: desk.group,
      offset: new THREE.Vector3(0, 3.3, 0),
      el: h('div.st-chip', { onclick: () => choose({ type: 'agent', id: agent.id, wf: wf.id }), title: `${agent.name} · ${agent.model || agent.engine}${isLead ? ' · team lead' : ''}` }, h('span.st-chip-dot'), isLead ? h('span.st-chip-lead', { title: 'Team lead' }, '★') : null, h('span.st-chip-name', agent.name), h('span.st-chip-model', shortModel(agent))),
    });
  });
  // the conversation gently circles the hub
  for (let k = 0; k < 3; k++) spawn({ parent: pod, path: (t: number) => new THREE.Vector3(Math.cos(t * Math.PI * 2) * R * 0.42, 0.62, Math.sin(t * Math.PI * 2) * R * 0.42), t: k / 3, speed: 0.06, color: light, size: 0.45, loop: true, opacity: 0.55 });

  // the team card, on the far side from the Brain
  const away = toBrain.lengthSq() > 0.01 ? toBrain.clone().normalize().multiplyScalar(-(R + 2.6)) : new THREE.Vector3(R + 2.6, 0, 0);
  const anchor = new THREE.Object3D();
  anchor.position.copy(away);
  pod.add(anchor);
  // an invisible box where the card sits, so zoom-to-fit keeps the card on screen
  const fitBox = new THREE.Mesh(new THREE.BoxGeometry(14, 0.1, 8), new THREE.MeshBasicMaterial({ visible: false }));
  fitBox.position.copy(away).addScaledVector(away.clone().normalize(), 7);
  pod.add(fitBox);
  const card = h('div.st-branch', { style: { '--c': wfColor(wf, i) }, onclick: () => choose({ type: 'branch', id: wf.id }) });
  // pinned by its edge, so it grows away from the pod instead of over it
  addLabel({ kind: 'branch', id: wf.id, obj: anchor, from: pod, offset: new THREE.Vector3(0, 0.5, 0), el: card });

  // the link to the Brain (redrawn when the team moves)
  const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new Array(33).fill(0).map(() => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: light, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
  S.world!.add(link);
  rails.push({ material: link.material, base: 0.45 });
  const b: Branch = { wf, index: i, color, group: pod, center: new THREE.Vector3(), radius: R, nodes: branchNodes, links: branchLinks, card, agentCount: members.length, rails, link, hub: { holo, holo2, hubGlow }, spin, flash: 0, home };
  b.along = (t: number) => linkPoint(b, t);
  S.branches.set(wf.id, b);
  updateLink(b);
  // a slow stream of light from the Brain to the team
  for (let k = 0; k < 2; k++) spawn({ path: (t: number) => linkPoint(b, t), t: k / 2, speed: 0.07 + Math.random() * 0.03, color: light, size: 0.5, loop: true, opacity: 0.45 });
  drawBranchCard(wf.id);
  return pod.position.length() + R + 16; // room for the team card too
}

// Brain edge → the team's hub, as a soft arc (world coordinates; follows the team when it moves).
function linkPoint(b: Branch, t: number): THREE.Vector3 {
  const p2 = b.group.position.clone().setY(1.7);
  const dir = p2.clone().setY(0);
  const len = dir.length() || 1;
  dir.divideScalar(len);
  const p0 = dir.clone().multiplyScalar(4.4).setY(0.9);
  const edge = b.group.position.clone().addScaledVector(dir, -b.radius).setY(0.7);
  const end = t < 0.85 ? edge : p2;
  const tt = t < 0.85 ? t / 0.85 : (t - 0.85) / 0.15;
  const from = t < 0.85 ? p0 : edge;
  const ctrl = from.clone().lerp(end, 0.5).setY(Math.max(from.y, end.y) + (t < 0.85 ? Math.min(6, len * 0.12) : 0.5));
  const u = 1 - tt;
  return from.clone().multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * tt).addScaledVector(end, tt * tt);
}
function updateLink(b: Branch): void {
  const pos = b.link.geometry.attributes.position;
  for (let k = 0; k <= 32; k++) {
    const p = linkPoint(b, (k / 32) * 0.85);
    pos.setXYZ(k, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  b.link.geometry.computeBoundingSphere();
}

// Light between two teammates, through the hub (an @mention handoff).
function pulseHandoff(teamId: string, fromId: string, toId: string, count = 6): void {
  const b = S?.branches.get(teamId);
  if (!b) return;
  const A = b.nodes.find((n) => n.agentId === fromId);
  const B = b.nodes.find((n) => n.agentId === toId);
  if (!A || !B) return;
  const hub = new THREE.Vector3(0, 1.9, 0);
  const path = polyline([A.pos.clone().setY(1.9), hub, B.pos.clone().setY(1.9)]);
  for (let k = 0; k < count; k++) spawn({ parent: b.group, path, t: -k * 0.07, speed: 0.8, color: new THREE.Color(0xfff2b0), size: 0.8, loop: false });
  b.flash = 1;
}
// The hub hands a message to one teammate (they start working on it).
function pulseToDesk(teamId: string, agentId: string, count = 4): void {
  const b = S?.branches.get(teamId);
  const N = b?.nodes.find((n) => n.agentId === agentId);
  if (!N) return;
  const path = polyline([new THREE.Vector3(0, 1.9, 0), N.pos.clone().setY(1.9)]);
  for (let k = 0; k < count; k++) spawn({ parent: b!.group, path, t: -k * 0.08, speed: 0.9, color: new THREE.Color(0xfff2b0), size: 0.7, loop: false });
  b!.flash = Math.max(b!.flash, 0.6);
}

function buildBench(agents: Agent[]): void {
  assertMounted(S);
  const dir = new THREE.Vector3(Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4));
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  const cols = Math.min(4, agents.length);
  const rows = Math.ceil(agents.length / 4);
  // its saved spot, or in front of the Brain
  const saved = S.layout?.bench;
  const center = saved && Number.isFinite(saved.x) ? new THREE.Vector3(saved.x, 0, saved.z) : dir.clone().multiplyScalar(11 + rows * 1.6);
  const bench = new THREE.Group();
  bench.position.copy(center);
  S.world!.add(bench);
  const w = cols * 3.4 + 1.2;
  const dd = rows * 3.2 + 1.2;
  const slabG = new THREE.Group();
  slabG.rotation.y = -Math.PI / 4;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(dd, 0.4, w), new THREE.MeshStandardMaterial({ color: 0x1b1f1b, roughness: 0.8, emissive: 0x2a3028, emissiveIntensity: 0.3 }));
  slab.position.y = 0.2;
  slabG.add(slab);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: 0x555850, transparent: true, opacity: 0.8 }));
  edges.position.copy(slab.position);
  slabG.add(edges);
  slabG.traverse((o) => (o.userData.pick = { type: 'bench' }));
  bench.add(slabG);
  agents.forEach((ag, j) => {
    const cx = (j % 4) - (cols - 1) / 2;
    const cz = Math.floor(j / 4) - (rows - 1) / 2;
    const desk = makeDesk(ag, ag.color || '#6b7066', 0);
    desk.group.position.copy(new THREE.Vector3()).addScaledVector(right, cx * 3.4).addScaledVector(dir, cz * 3.2).setY(0.4);
    desk.group.traverse((o) => (o.userData.pick = { type: 'agent', id: ag.id }));
    bench.add(desk.group);
    S!.desks.push(desk);
    S!.benchNodes.push({ kind: 'agent', obj: desk.group, links: agentLinks(ag), desk, agentId: ag.id, wfId: null, index: -1 });
    addLabel({ kind: 'agent', id: ag.id, obj: desk.group, offset: new THREE.Vector3(0, 3.2, 0), el: h('div.st-chip', { onclick: () => choose({ type: 'agent', id: ag.id }), title: `${ag.name} · ${ag.model || ag.engine}` }, h('span.st-chip-dot'), ag.name, h('span.st-chip-model', shortModel(ag))) });
  });
  const anchor = new THREE.Object3D();
  anchor.position.copy(dir).multiplyScalar(rows * 1.6 + 3.2);
  bench.add(anchor);
  S.bench = bench;
  S.benchCenter = center.clone();
  addLabel({
    kind: 'bench',
    id: 'bench',
    obj: anchor,
    offset: new THREE.Vector3(0, 0, 0),
    el: h('div.st-bench', { onclick: () => choose({ type: 'bench' }), title: 'Drag the Bench platform to move it' }, h('div.st-branch-name', icon('move', 12), 'BENCH'), h('div.hint', `${agents.length} agent${agents.length === 1 ? '' : 's'} not on a team yet`)),
  });
}

// "sonnet" → "Sonnet", "anthropic/claude-sonnet-5.5" → "sonnet-5.5", Hermes → its profile.
function shortModel(a: Pick<Agent, 'engine' | 'model' | 'hermesProfile'>): string {
  if (a.engine === 'hermes') return a.model || a.hermesProfile || 'hermes';
  const m = String(a.model || '').split('/').pop()!.replace(/^claude-/, '');
  return m || a.engine;
}

function polyline(points: THREE.Vector3[]): (t: number) => THREE.Vector3 {
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const l = points[i].distanceTo(points[i + 1]);
    lens.push(l);
    total += l;
  }
  return (t) => {
    let d = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i] || i === lens.length - 1) return points[i].clone().lerp(points[i + 1], lens[i] ? Math.min(1, d / lens[i]) : 0);
      d -= lens[i];
    }
    return points[0].clone();
  };
}

// The fraction of a branch's path where step j sits.
function stepT(branch: { path: THREE.Vector3[] }, j: number): number {
  const pts = branch.path;
  let total = 0;
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) cum.push((total += pts[i].distanceTo(pts[i + 1])));
  return total ? cum[Math.min(j + 1, cum.length - 1)] / total : 0;
}

function makeDesk(agent: Agent, colorHex: string, stepNo: string | number): Desk {
  const g = new THREE.Group();
  const color = new THREE.Color(colorHex);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1e1a, roughness: 0.7 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.3), new THREE.MeshStandardMaterial({ color: 0x2a2f29, roughness: 0.6 }));
  top.position.y = 0.9;
  g.add(top);
  for (const x of [-1.15, 1.15]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 1.1), dark);
    leg.position.set(x, 0.45, 0);
    g.add(leg);
  }
  const mon = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.08, 0.08), new THREE.MeshStandardMaterial({ color: 0x0e100e, roughness: 0.4, metalness: 0.4 }));
  mon.position.set(0, 1.68, -0.38);
  g.add(mon);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.12), dark);
  stand.position.set(0, 1.05, -0.38);
  g.add(stand);
  const screen = canvasTex(512, 320, () => {});
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 0.98), new THREE.MeshBasicMaterial({ map: screen.tex, toneMapped: false }));
  scr.position.set(0, 1.68, -0.33);
  g.add(scr);
  const screenGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: 0xdfe3d8, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
  screenGlow.scale.set(3.2, 2.4, 1);
  screenGlow.position.set(0, 1.7, -0.2);
  g.add(screenGlow);
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.12, 0.7), dark);
  chair.position.set(0, 0.6, 0.75);
  g.add(chair);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.1), dark);
  back.position.set(0, 0.98, 1.08);
  g.add(back);
  const person = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.65, 12), new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.15), roughness: 0.6 }));
  body.position.y = 0.98;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), new THREE.MeshStandardMaterial({ color: 0xe6e8e0, roughness: 0.5 }));
  head.position.y = 1.5;
  person.add(body, head);
  person.position.z = 0.62;
  g.add(person);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), new THREE.MeshBasicMaterial({ color: 0x6b7066 }));
  orb.position.set(0.95, 2.45, -0.38);
  g.add(orb);
  const orbGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: 0xc4ff3d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  orbGlow.scale.set(1.4, 1.4, 1);
  orbGlow.position.copy(orb.position);
  g.add(orbGlow);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.07, 8, 48), new THREE.MeshBasicMaterial({ color: 0xc4ff3d, transparent: true, opacity: 0 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.08;
  g.add(ring);
  const focusRing = new THREE.Mesh(new THREE.RingGeometry(1.55, 2.25, 48), new THREE.MeshBasicMaterial({ color: 0xc4ff3d, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  focusRing.rotation.x = -Math.PI / 2;
  focusRing.position.y = 0.06;
  g.add(focusRing);
  const desk: Desk = { group: g, agent, color: colorHex, stepNo: stepNo || '-', screen, screenGlow, person, orb, orbGlow, ring, focusRing, status: 'idle', activity: '' };
  drawScreen(desk);
  return desk;
}

function spawn(p: ParticleSpec): void {
  assertMounted(S);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: p.color, transparent: true, opacity: p.opacity ?? 1, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.set(p.size, p.size, 1);
  sp.visible = false;
  (p.parent || S.world!).add(sp);
  S.particles.push({ ...p, sprite: sp });
}

// Light running along a branch, from one point (0 = Brain) to another (1 = last step).
// Light between the Brain (0) and a team's hub (1).
function pulseAlong(wfId: string, from = 0, to = 1, count = 5): void {
  const b = S?.branches.get(wfId);
  if (!b) return;
  for (let i = 0; i < count; i++) spawn({ path: (t: number) => linkPoint(b, from + (to - from) * t), t: -i * 0.08, speed: 0.7, color: new THREE.Color(0xfff2b0), size: 0.9, loop: false });
  b.flash = Math.max(b.flash || 0, 0.5);
}

function pulseIntegration(intId: string, node: MapNode | null): void {
  if (!S) return;
  const tile = S.tileEls?.get(intId);
  if (tile) {
    tile.classList.remove('flash');
    void tile.offsetWidth;
    tile.classList.add('flash');
  }
  // light both the desk's own wire and its team's combined wire (whichever is showing runs the light)
  for (const l of [...(S.links2d || []), ...(S.links2dAll || [])]) {
    if (l.intId !== intId) continue;
    if (node && (l.node ? l.node !== node : !l.members?.includes(node))) continue;
    l.flash = 1;
    for (let i = 0; i < 3; i++) S.dots.push({ link: l, t: -i * 0.12 });
  }
}


// ---------- statuses ----------
function updateStatuses(): void {
  const d = state.data;
  if (!d || !S) return;
  for (const desk of S.desks) {
    const needs = d.approvals.some((a) => a.agentId === desk.agent.id);
    const working = d.runs.some((r) => r.agentId === desk.agent.id);
    const st = needs ? 'needs' : working ? 'working' : 'idle';
    if (st !== desk.status) {
      desk.status = st;
      if (st === 'idle') {
        desk.activity = '';
        desk.act = null;
      }
      desk.orb.material.color.set(st === 'needs' ? 0xff5a5a : st === 'working' ? 0xc4ff3d : 0x6b7066);
      desk.orbGlow.material.color.set(st === 'needs' ? 0xff5a5a : 0xc4ff3d);
      desk.screenGlow.material.color.set(st === 'working' ? 0xc4ff3d : st === 'needs' ? 0xf0b04a : 0xdfe3d8);
      drawScreen(desk, S.clock.elapsedTime);
    }
  }
  // the step a running workflow is on gets a ring
  for (const node of S.nodes) {
    const ts = S.teamState?.[node.wfId];
    const st = (ts?.working?.includes(node.agentId!) ? 'running' : ts?.queued?.includes(node.agentId!) ? 'needs-you' : null) as RunStatus | null;
    node.runStatus = st || null;
    const ring = node.kind === 'agent' ? node.desk.ring : node.ring;
    ring.material.color.set(st === 'needs-you' ? 0xf0b04a : st === 'failed' ? 0xff5a5a : st === 'done' ? 0x7a9a2c : 0xc4ff3d);
    ring.material.opacity = st === 'running' || st === 'needs-you' ? 0.9 : st === 'done' ? 0.35 : st === 'failed' ? 0.7 : 0;
  }
  for (const l of S.labelEls) {
    if (l.kind === 'agent') {
      l.el.dataset.status = d.approvals.some((a) => a.agentId === l.id) ? 'needs' : d.runs.some((r) => r.agentId === l.id) ? 'working' : 'idle';
      if (l.wf) {
        const node = S.nodes.find((n) => n.kind === 'agent' && n.wfId === l.wf && n.agentId === l.id);
        if (node?.runStatus === 'running' || node?.runStatus === 'needs-you') l.el.dataset.status = node.runStatus === 'needs-you' ? 'needs' : 'working';
      }
    }
    if (l.kind === 'step') {
      const [wfId, j] = l.id.split(':');
      l.el.dataset.status = S.active.get(wfId)?.steps?.[Number(j)]?.status || 'idle';
    }
  }
  for (const id of S.branches.keys()) drawBranchCard(id);
}

function wfStats(wfId: string) {
  assertMounted(S);
  const runs = S.wfRuns.filter((r) => r.workflowId === wfId);
  return { total: runs.length, done: runs.filter((r) => r.status === 'done').length, failed: runs.filter((r) => r.status === 'failed').length, last: runs[0] || null };
}

function scheduleText(s: (Schedule & { minutes?: number }) | undefined): string {
  if (!s || s.type === 'none') return 'manual';
  if (s.type === 'interval') return `every ${s.minutes || 60} min`;
  return `daily ${s.time || '09:00'}`;
}

function drawBranchCard(wfId: string): void {
  assertMounted(S);
  const b = S.branches.get(wfId);
  if (!b) return;
  const wf = b.wf;
  const ts = S.teamState?.[wfId] || { working: [], queued: [] };
  const last = S.teamLast?.[wfId];
  const nameOf = (id: string) => (id === 'user' ? 'You' : id === 'system' ? '' : state.data?.agents.find((a) => a.id === id)?.name || '');
  const lead = wf.lead ? nameOf(wf.lead) : '';
  b.card.classList.toggle('live', ts.working.length > 0);
  b.card.classList.toggle('needs', false);
  mount(
    b.card,
    h('div.st-branch-name', h('span.st-dot'), wf.name.toUpperCase()),
    h('div.st-branch-big', h('b', String(wf.members.length)), h('span', wf.members.length === 1 ? 'AGENT' : 'AGENTS'), lead ? h('span.st-branch-steps', `★ ${lead}`) : null),
    wf.description ? h('div.st-branch-desc', wf.description) : null,
    b.links.size ? h('div.st-dept-icons', [...b.links].slice(0, 7).map(badge)) : null,
    last ? h('div.st-branch-last', h('b', nameOf(last.from) || 'Team'), ' ', String(last.text).replace(/\s+/g, ' ').slice(0, 90), h('span.hint', ` · ${ago(last.ts)}`)) : null,
    h(
      'div.st-branch-foot',
      ts.working.length
        ? h('span.live', `● ${ts.working.map(nameOf).join(', ')} working${ts.queued.length ? ` · ${ts.queued.length} next` : ''}`)
        : h('span', wf.enabled && wf.schedule?.type !== 'none' ? `⏱ ${scheduleText(wf.schedule)}` : last ? 'quiet' : 'say hi to the team'),
    ),
  );
}

// ---------- labels ----------
function addLabel(l: LabelSpec & { world?: THREE.Vector3 }): void {
  assertMounted(S);
  S.labels.append(l.el);
  l.el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openMenu(ev, labelPick(l as Label));
  });
  if (l.kind === 'branch' || l.kind === 'agent') {
    l.el.addEventListener('pointerenter', () => S && (S.hover = hoverFor(labelPick(l as Label))));
    l.el.addEventListener('pointerleave', () => S && (S.hover = null));
  }
  l.world = new THREE.Vector3();
  S.labelEls.push(l as Label);
}

// The connections a team (its card or platform) or an agent (its chip or desk) uses.
function hoverFor(p: MapPick | null): Hover | null {
  if (!S || !p) return null;
  if (p.type === 'branch') {
    const b = S.branches.get(p.id);
    if (!b) return null;
    return { links: b.links, nodes: new Set(S.nodes.filter((n) => n.wfId === p.id)) };
  }
  if (p.type === 'agent') {
    const nodes = (p.wf ? S.nodes : S.benchNodes || []).filter((n): n is AgentNode => n.kind === 'agent' && n.agentId === p.id && (!p.wf || ((n as PodNode).wfId === p.wf && (p.step == null || n.index === p.step))));
    if (!nodes.length) return null;
    const links = new Set<string>();
    for (const n of nodes) n.links.forEach((l) => links.add(l));
    return { links, nodes: new Set(nodes) };
  }
  return null;
}

// A header tile (program, service, MCP server, Claude connector): the agents whose wires run to it.
function hoverForLink(intId: string): Hover | null {
  if (!S) return null;
  const nodes = [...S.nodes, ...(S.benchNodes || [])].filter((n) => n.links.has(intId));
  const agents = new Set(nodes.filter((n): n is AgentNode => n.kind === 'agent').map((n) => n.agentId));
  return { links: new Set([intId]), nodes: new Set(nodes), agents, only: true, color: intInfo(intId)?.color };
}

// An AI engine (top right): the agents that run on it, with their wires to its tile.
const ENGINE_TILES = ['claude', 'codex', 'hermes', 'openrouter', 'lmstudio', 'ollama'];
function hoverForEngine(engine: string, brain: boolean, color: string): Hover | null {
  if (!S) return null;
  const ids = new Set((state.data?.agents || []).filter((a) => a.engine === engine).map((a) => a.id));
  const nodes = [...S.nodes, ...(S.benchNodes || [])].filter((n): n is AgentNode => n.kind === 'agent' && ids.has(n.agentId));
  const links = new Set<string>();
  for (const n of nodes) for (const l of n.links) if (ENGINE_TILES.includes(l)) links.add(l);
  return { links, nodes: new Set(nodes), agents: ids, only: true, brain, color };
}

// Mark what the hover lights: agent chips, team cards, the Brain; the rest fades (CSS does the look).
function applyHover(): void {
  if (!S || S.hoverShown === S.hover) return;
  S.hoverShown = S.hover;
  const f = S.hover;
  const lit = f?.agents;
  S.labels.classList.toggle('focus', !!lit);
  const teamsLit = new Set<string>();
  if (lit) for (const w of S.workflows) if ((w.members || []).some((id) => lit.has(id))) teamsLit.add(w.id);
  for (const l of S.labelEls) {
    const on = !!lit && ((l.kind === 'agent' && lit.has(l.id)) || (l.kind === 'branch' && teamsLit.has(l.id)) || (l.kind === 'brain' && !!f?.brain));
    l.el.classList.toggle('hot', on);
  }
  const c = new THREE.Color(f?.color || '#c4ff3d');
  for (const d of S.desks) d.focusRing.material.color.copy(c);
}

const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
function placeLabels(): void {
  assertMounted(S);
  const z = S.cam.zoom;
  const pxPerUnit = S.h / (S.cam.view / z);
  for (const l of S.labelEls) {
    l.obj.getWorldPosition(l.world);
    v3.copy(l.world).add(l.offset).project(S.camera);
    const x = (v3.x + 1) * 0.5 * S.w;
    const y = (1 - v3.y) * 0.5 * S.h;
    const off = x < -200 || x > S.w + 200 || y < -200 || y > S.h + 200;
    const hide = off || ((l.kind === 'agent' || l.kind === 'step') && z < 0.6) || (l.kind === 'int' && z < 0.5);
    l.el.style.display = hide ? 'none' : '';
    const sc = l.kind === 'branch' || l.kind === 'bench' ? Math.min(1.1, Math.max(0.5, (16 * pxPerUnit) / 214)) : 1;
    let tx = -50;
    let ty = -50;
    if (l.from && !hide) {
      // which way is the anchor from the pod's centre on screen? the card sits on that side
      l.from.getWorldPosition(v3b);
      v3b.project(S.camera);
      const dx = x - (v3b.x + 1) * 0.5 * S.w;
      const dy = y - (1 - v3b.y) * 0.5 * S.h;
      if (Math.abs(dx) >= Math.abs(dy) * 0.6) tx = dx < 0 ? -100 : 0;
      else ty = dy < 0 ? -100 : 0;
      l.el.style.transformOrigin = `${-tx}% ${-ty}%`;
    }
    if (!hide) l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${tx}%, ${ty}%) scale(${sc.toFixed(3)})`;
  }
  S.labels.dataset.zoom = z > 1.6 ? 'near' : z < 0.75 ? 'far' : 'mid';
}

// ---------- animation ----------
function loop(): void {
  if (!S?.alive) return;
  requestAnimationFrame(loop);
  const dt = Math.min(S.clock.getDelta(), 0.05);
  const t = S.clock.elapsedTime;
  const d = state.data;
  const busy = (d?.runs?.length || 0) + S.active.size;
  // smooth camera moves
  const goal = S.cam.goal;
  if (goal) {
    const k = 1 - Math.pow(0.0015, dt);
    S.cam.target.lerp(goal.target, k);
    S.cam.zoom += (goal.zoom - S.cam.zoom) * k;
    if (S.cam.target.distanceTo(goal.target) < 0.02 && Math.abs(goal.zoom - S.cam.zoom) < 0.002) S.cam.goal = null;
    updateCamera();
  }
  const b = S.brain;
  b.cloud.rotation.y += dt * (0.15 + Math.min(busy, 4) * 0.25);
  b.ico.rotation.y -= dt * 0.1;
  b.ico.rotation.x += dt * 0.05;
  const pulse = 0.5 + 0.5 * Math.sin(t * (busy ? 4 : 1.4));
  b.halo.material.opacity = 0.45 + pulse * (busy ? 0.45 : 0.15);
  b.halo.scale.setScalar(10 + pulse * (busy ? 3 : 1));
  b.beam.material.opacity = 0.1 + (busy ? 0.12 + pulse * 0.12 : 0.04);
  b.star.scale.setScalar(5 + pulse * (busy ? 3 : 0.8));
  b.light.intensity = 25 + pulse * (busy ? 40 : 8);
  // files held over the Brain: it opens up to take them
  if (S.fileDrag === 'brain') {
    const grab = 0.5 + 0.5 * Math.sin(t * 7);
    b.halo.material.opacity = 0.95;
    b.halo.scale.setScalar(15 + grab * 2.5);
    b.light.intensity = 90 + grab * 30;
    b.cloud.rotation.y += dt * 1.6;
  }
  if (b.logo) {
    // floats and breathes inside the globe; a little livelier while agents work
    b.logo.position.y = 3.2 + Math.sin(t * 1.1) * 0.16;
    const base = b.logo.userData.base as THREE.Vector3;
    const k = 1 + Math.sin(t * (busy ? 3.2 : 1.6)) * (busy ? 0.05 : 0.025);
    b.logo.scale.set(base.x * k, base.y * k, 1);
    b.logo.material.rotation = Math.sin(t * 0.5) * 0.06;
  }

  // desks of the agents a hovered tile or engine lights (fade in and out)
  const lit = S.hover?.agents;
  for (const desk of S.desks) {
    const want = lit?.has(desk.agent.id) ? 0.85 + 0.15 * Math.sin(t * 5) : 0;
    const m = desk.focusRing.material;
    m.opacity += (want - m.opacity) * Math.min(1, dt * 10);
    desk.focusRing.visible = m.opacity > 0.01;
  }
  for (const desk of S.desks) {
    if (desk.status === 'working') {
      desk.person.position.y = Math.abs(Math.sin(t * 6 + desk.agent.id.length)) * 0.06;
      desk.orb.scale.setScalar(1 + 0.35 * Math.sin(t * 5));
      desk.orbGlow.material.opacity = 0.5 + 0.3 * Math.sin(t * 5);
      if (!desk.lastDraw || t - desk.lastDraw > 0.35) {
        desk.lastDraw = t;
        drawScreen(desk, t);
      }
    } else if (desk.status === 'needs') {
      const on = Math.sin(t * 8) > 0;
      if (!desk.lastDraw || t - desk.lastDraw > 0.5) {
        desk.lastDraw = t;
        drawScreen(desk, t);
      }
      desk.orb.scale.setScalar(on ? 1.5 : 1);
      desk.orbGlow.material.opacity = on ? 0.9 : 0.2;
      desk.person.position.y = 0;
    } else {
      desk.orb.scale.setScalar(1);
      desk.orbGlow.material.opacity = 0;
      desk.person.position.y = 0;
    }
  }
  for (const node of S.nodes) {
    if (node.runStatus === 'running' || node.runStatus === 'needs-you') {
      const ring = node.kind === 'agent' ? node.desk.ring : node.ring;
      ring.scale.setScalar(1 + 0.08 * Math.sin(t * 5));
    }
  }
  for (const n of S.intNodes.values()) {
    if (n.flash > 0) n.flash = Math.max(0, n.flash - dt * 0.8);
    n.glow.material.opacity = (n.it.live ? 0.3 : 0.08) + n.flash * 0.6;
    n.glow.scale.setScalar(6 + n.flash * 4);
  }
  for (const c of S.curves) {
    if (c.flash > 0) c.flash = Math.max(0, c.flash - dt * 0.6);
    c.line.material.opacity = c.base + c.flash * 0.6;
  }
  for (const [id, br] of S.branches) {
    const live = S.active.has(id) || br.nodes.some((n) => n.kind === 'agent' && n.desk.status !== 'idle') || (S.teamState?.[id]?.working || []).length > 0;
    if (br.flash > 0) br.flash = Math.max(0, br.flash - dt * 0.9);
    for (const r of br.rails) r.material.opacity = live ? Math.min(1, r.base + 0.35 + 0.2 * Math.sin(t * 6)) : r.base + br.flash * 0.4;
    if (br.hub) {
      br.hub.holo.rotation.z += dt * (live ? 1.6 : 0.35);
      br.hub.holo2.rotation.x += dt * (live ? 2.2 : 0.5);
      br.hub.hubGlow.material.opacity = 0.35 + (live ? 0.25 + 0.15 * Math.sin(t * 5) : 0) + br.flash * 0.5;
      br.hub.hubGlow.scale.setScalar(4.5 + br.flash * 3 + (live ? Math.sin(t * 5) * 0.4 : 0));
    }
  }
  for (let i = S.particles.length - 1; i >= 0; i--) {
    const p = S.particles[i];
    p.t += dt * p.speed;
    if (p.t > 1) {
      if (p.loop) p.t -= 1;
      else {
        (p.parent || S.world!).remove(p.sprite);
        p.sprite.material.dispose();
        S.particles.splice(i, 1);
        continue;
      }
    }
    p.sprite.visible = p.t >= 0;
    if (p.t >= 0) p.sprite.position.copy(p.path(p.t));
  }
  placeLabels();
  drawWires(dt);
  S.renderer.render(S.scene, S.camera);
}

// The dashed wires: header tile (top) to the desk or pedestal (in the map), as SVG curves.
const SVGNS = 'http://www.w3.org/2000/svg';
function drawWires(dt: number): void {
  assertMounted(S);
  const svg = S.wires;
  if (!svg) return;
  // nothing hovered: the combined wires (one per team); hovering: every desk's own wire
  const links = (S.hover ? S.links2d : S.links2dAll) || S.links2d || [];
  const rootBox = S.root.getBoundingClientRect();
  const bar = S.hudTop?.querySelector('.st-connected')?.getBoundingClientRect();
  while (svg.childNodes.length < links.length) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-dasharray', '3 4');
    svg.append(p);
  }
  while (svg.childNodes.length > links.length) svg.lastChild!.remove();
  // a hovered team or agent: light only its tiles and wires
  const focus = S.hover;
  applyHover();
  S.hudTop?.querySelector('.st-connected')?.classList.toggle('focus', !!focus);
  // hovering a tile or an engine: the other tiles stay readable (only a light dim)
  S.hudTop?.querySelector('.st-connected')?.classList.toggle('soft', !!focus?.only);
  S.tileEls?.forEach((el, id) => el.classList.toggle('hot', !!focus?.links.has(id)));
  const ends: (number[] | null)[] = [];
  links.forEach((l, i) => {
    assertMounted(S);
    const p = svg.childNodes[i] as SVGPathElement;
    const tile = S.tileEls?.get(l.intId);
    const r = tile?.getBoundingClientRect();
    const visible = r && r.width && bar && r.left >= bar.left - 2 && r.right <= bar.right + 2;
    if (!visible) {
      p.setAttribute('d', '');
      ends.push(null);
      return;
    }
    const x1 = r.left + r.width / 2 - rootBox.left;
    const y1 = r.bottom - rootBox.top + 2;
    if (l.node) {
      l.node.obj.getWorldPosition(v3);
      v3.y += l.node.kind === 'agent' ? 2.3 : 1.3;
    } else {
      l.anchor!.getWorldPosition(v3);
      v3.y += l.lift || 1.5;
    }
    v3.project(S.camera);
    const x2 = (v3.x + 1) * 0.5 * S.w;
    const y2 = (1 - v3.y) * 0.5 * S.h;
    const dy = Math.max(60, (y2 - y1) * 0.55);
    const c = [x1, y1, x1, y1 + dy, x2, y2 - dy * 0.6, x2, y2];
    ends.push(c);
    p.setAttribute('d', `M${c[0].toFixed(1)},${c[1].toFixed(1)} C${c[2].toFixed(1)},${c[3].toFixed(1)} ${c[4].toFixed(1)},${c[5].toFixed(1)} ${c[6].toFixed(1)},${c[7].toFixed(1)}`);
    if (l.flash > 0) l.flash = Math.max(0, l.flash - dt * 0.7);
    const info = intInfo(l.intId);
    const mine = !!l.node && !!focus?.nodes.has(l.node) && (!focus.only || focus.links.has(l.intId));
    // a combined wire is a little thicker the more agents it stands for
    const weight = l.members ? Math.min(1.6, (l.members.length - 1) * 0.3) : 0;
    const live = focus && !mine ? 0.03 : tile!.classList.contains('off') ? 0.12 : mine ? 0.7 : 0.32;
    p.setAttribute('stroke', info?.color || '#8f968a');
    p.setAttribute('stroke-opacity', String(live + l.flash * 0.6));
    p.setAttribute('stroke-width', String((mine ? 1.5 : 1) + weight + l.flash * 1.2));
  });
  // light running down a wire
  const dotsLayer = S.wireDots;
  S.dots = S.dots.filter((d) => (d.t += dt * 0.9) <= 1);
  while (dotsLayer.childNodes.length < S.dots.length) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('r', '3');
    dotsLayer.append(c);
  }
  while (dotsLayer.childNodes.length > S.dots.length) dotsLayer.lastChild!.remove();
  S.dots.forEach((d, i) => {
    const el = dotsLayer.childNodes[i] as SVGCircleElement;
    const c = ends[links.indexOf(d.link)];
    if (!c || d.t < 0) return el.setAttribute('opacity', '0');
    const t = d.t;
    const u = 1 - t;
    const bx = u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
    const by = u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7];
    el.setAttribute('cx', bx.toFixed(1));
    el.setAttribute('cy', by.toFixed(1));
    el.setAttribute('fill', intInfo(d.link.intId)?.color || '#fff');
    el.setAttribute('opacity', '0.95');
  });
}

// ---------- controls ----------
type DragMode = 'spin' | 'branch' | 'rotate' | 'agent' | 'pan' | 'bench';
interface Drag {
  x: number;
  y: number;
  sx: number;
  sy: number;
  button: number;
  shift: boolean;
  pick: MapPick | null;
  mode: DragMode | null;
  grab?: THREE.Vector3;
}
function setupControls(): void {
  assertMounted(S);
  const elc = S.renderer.domElement;
  let drag: Drag | null = null;
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const setMouse = (e: MouseEvent) => {
    const r = elc.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, S!.camera);
  };
  const pick = (e: MouseEvent): MapPick | null => {
    setMouse(e);
    const hits = ray.intersectObjects(S!.scene.children, true).filter((x) => x.object.userData.pick && x.object.visible && !(x.object instanceof THREE.Points) && !(x.object instanceof THREE.Line) && !x.object.userData.dragging);
    return ((hits.find((x) => (x.object.userData.pick as MapPick).type === 'agent') || hits[0])?.object.userData.pick as MapPick | undefined) || null;
  };
  const ground = (e: MouseEvent) => {
    setMouse(e);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  };
  // files dragged in from the desktop: only the Brain takes them
  const onBrain = (e: DragEvent) => pick(e)?.type === 'brain';
  elc.addEventListener('dragenter', (e) => mapDragOver(e, onBrain(e)));
  elc.addEventListener('dragover', (e) => mapDragOver(e, onBrain(e)));
  elc.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (onBrain(e)) brainDrop(e);
    else setFileDrag(null);
  });
  S.root.addEventListener('dragleave', (e) => !S?.root.contains(e.relatedTarget as Node | null) && setFileDrag(null));
  // dropped anywhere on the Station (a panel, the header): the hint goes
  S.root.addEventListener('drop', () => setFileDrag(null), true);
  elc.addEventListener('contextmenu', (e) => e.preventDefault());
  elc.addEventListener('pointerleave', () => S && (S.hover = null));
  elc.addEventListener('pointerdown', (e) => {
    closeMenu();
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, shift: e.shiftKey, pick: pick(e), mode: null };
    S!.cam.goal = null;
    elc.setPointerCapture(e.pointerId);
  });
  elc.addEventListener('pointermove', (e) => {
    assertMounted(S);
    if (!drag) {
      const p = pick(e);
      S.hover = hoverFor(p);
      elc.style.cursor = p ? (p.type === 'agent' || p.type === 'bench' || (p.type === 'branch' && p.step == null) ? 'grab' : 'pointer') : 'default';
      elc.title = p?.type === 'branch' ? 'Drag to move the team · Shift+drag to spin it · right-click for more' : '';
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    // decide what this drag does once the mouse has really moved
    if (!drag.mode && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
      const p = drag.pick;
      if (drag.button !== 2 && p?.type === 'branch' && p.step == null && S.branches.get(p.id)) {
        const b = S.branches.get(p.id)!;
        const g = ground(e);
        drag.mode = drag.shift ? 'spin' : 'branch';
        drag.grab = g ? b.group.position.clone().sub(g.setY(0)) : new THREE.Vector3();
      } else if (drag.button === 2 || drag.shift) drag.mode = 'rotate';
      else if (p?.type === 'agent') drag.mode = startAgentDrag(p, e.ctrlKey) ? 'agent' : 'pan';
      else if (p?.type === 'bench' && S.bench) {
        const g = ground(e);
        drag.mode = 'bench';
        drag.grab = g ? S.bench.position.clone().sub(g.setY(0)) : new THREE.Vector3();
      }
      else drag.mode = 'pan';
    }
    if (drag.mode === 'rotate') {
      S.cam.az -= dx * 0.005;
      updateCamera();
    } else if (drag.mode === 'pan') {
      const k = S.cam.view / S.cam.zoom / S.h;
      const right = new THREE.Vector3().setFromMatrixColumn(S.camera.matrix, 0);
      const fwd = new THREE.Vector3(-Math.sin(S.cam.az), 0, -Math.cos(S.cam.az));
      S.cam.target.addScaledVector(right, -dx * k).addScaledVector(fwd, (dy * k) / Math.sin(S.cam.el));
      updateCamera();
    } else if (drag.mode === 'branch') {
      const g = ground(e);
      if (g) moveBranch(drag.pick!.id!, g.setY(0).add(drag.grab!));
    } else if (drag.mode === 'spin') {
      spinBranch(drag.pick!.id!, dx * 0.012);
    } else if (drag.mode === 'agent') {
      const g = ground(e);
      if (g) moveAgentDrag(g, e);
    } else if (drag.mode === 'bench') {
      const g = ground(e);
      if (g) {
        S.bench!.position.copy(g.setY(0).add(drag.grab!));
        S.benchCenter = S.bench!.position.clone();
      }
    }
    if (drag.mode) elc.style.cursor = 'grabbing';
  });
  elc.addEventListener('pointerup', (e) => {
    assertMounted(S);
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.mode) {
      if (d.button === 2) openMenu(e, d.pick);
      else choose(d.pick);
    } else if (d.mode === 'branch' || d.mode === 'spin') saveBranchPlace(d.pick!.id!);
    else if (d.mode === 'agent') dropAgent();
    else if (d.mode === 'bench' && S.bench) saveLayout({ bench: { x: +S.bench.position.x.toFixed(2), z: +S.bench.position.z.toFixed(2) } });
  });
  elc.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e);
    },
    { passive: false },
  );
  S.onKey = (e) => {
    assertMounted(S);
    if ((e.target as Element).closest?.('input, textarea, select')) return;
    // Esc closes the Station's own menu or panel; with nothing open, app.ts opens the big sidebar
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return; // a dialog or the Brain chat took it
      if (S.menu) {
        closeMenu();
        e.preventDefault();
      } else if (S.selected) {
        choose(null);
        e.preventDefault();
      }
    }
    if (e.key === '+' || e.key === '=') zoomAt(1.25);
    if (e.key === '-') zoomAt(0.8);
    if (e.key === '0') resetView();
  };
  window.addEventListener('keydown', S.onKey);
  S.onDocDown = (e) => {
    if (S?.menu && !S.menu.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('pointerdown', S.onDocDown, true);
}

// ---------- files dropped on the Brain ----------
// While files are over the map: a hint says where to drop them, and the Brain glows when they are over it.
function setFileDrag(mode: 'map' | 'brain' | null): void {
  if (!S || S.fileDrag === mode) return;
  S.fileDrag = mode;
  S.labels.querySelector('.st-brain-label')?.classList.toggle('att-target', mode === 'brain');
  if (!mode) {
    S.dropHint?.remove();
    S.dropHint = null;
    return;
  }
  if (!S.dropHint) {
    S.dropHint = h('div.st-drop-hint');
    S.root.append(S.dropHint);
  }
  S.dropHint.classList.toggle('on', mode === 'brain');
  mount(S.dropHint, icon(mode === 'brain' ? 'brain' : 'upload', 15), mode === 'brain' ? 'Let go to give these to the Brain' : 'Drop the files on the Brain');
}

function mapDragOver(e: DragEvent, overBrain: boolean): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = overBrain ? 'copy' : 'none';
  setFileDrag(overBrain ? 'brain' : 'map');
}

function brainDragOver(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.stopPropagation();
  mapDragOver(e, true);
}

// They upload into the Brain folder and the Brain chat opens with them attached, ready for what to do with them.
function brainDrop(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  setFileDrag(null);
  void filesFromDrop(e.dataTransfer!).then((picked) => {
    if (!picked.length) return;
    attachToBrain(picked);
    pulseBrain();
  });
}

// A quick burst of light from the Brain out to every team: it took something in.
function pulseBrain(): void {
  if (!S) return;
  for (const id of S.branches.keys()) pulseAlong(id, 0, 1, 3);
}

// ---------- moving teams ----------
function moveBranch(wfId: string, at: THREE.Vector3): void {
  assertMounted(S);
  const b = S.branches.get(wfId);
  if (!b) return;
  // keep clear of the Brain
  const minR = 6 + b.radius;
  if (at.length() < minR) at.setLength(minR);
  b.group.position.copy(at);
  b.moved = true;
  updateLink(b);
}
function spinBranch(wfId: string, by: number): void {
  assertMounted(S);
  const b = S.branches.get(wfId);
  if (!b) return;
  b.spin = (b.spin || 0) + by;
  b.group.rotation.y = -b.spin;
  b.moved = true;
  for (const d of S.desks) if (d.wfId === wfId) d.branchAngle = b.spin;
  updateCamera();
}
async function saveBranchPlace(wfId: string): Promise<void> {
  assertMounted(S);
  const b = S.branches.get(wfId);
  const wf = S.workflows.find((w) => w.id === wfId);
  if (!b || !wf || !b.moved) return;
  b.moved = false;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  await saveWorkflow({ ...wf, pos: { x: r3(b.group.position.x), z: r3(b.group.position.z) }, rot: r3(b.spin || 0) });
}

async function saveLayout(patch: StationLayout): Promise<void> {
  assertMounted(S);
  S.layout = { ...(S.layout || {}), ...patch };
  await attempt(() => PUT('/layout', patch));
}


// ---------- moving agents ----------
function startAgentDrag(p: MapPick, copy = false): boolean {
  assertMounted(S);
  const desk = S.desks.find((d) => d.agent.id === p.id && (p.wf ? d.wfId === p.wf && d.stepIndex === p.step : !d.wfId));
  if (!desk) return false;
  const marker = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.09, 8, 48), new THREE.MeshBasicMaterial({ color: 0xc4ff3d, transparent: true, opacity: 0 }));
  marker.rotation.x = Math.PI / 2;
  S.world!.add(marker);
  const hint = h('div.st-drag-hint');
  S.root.append(hint);
  desk.group.traverse((o) => (o.userData.dragging = true));
  S.agentDrag = { desk, home: desk.group.position.clone(), marker, hint, target: null, copy };
  return true;
}

function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function moveAgentDrag(g: THREE.Vector3, e: MouseEvent): void {
  assertMounted(S);
  const st = S.agentDrag;
  if (!st) return;
  const local = st.desk.group.parent!.worldToLocal(g.clone());
  st.desk.group.position.set(local.x, 1.4, local.z);
  // which team pod is under the mouse?
  let target: DropTarget | null = null;
  for (const [id, b] of S.branches) {
    const c = b.group.position;
    if (Math.hypot(c.x - g.x, c.z - g.z) < b.radius + 1.2) {
      target = { wfId: id, at: c.clone(), radius: b.radius };
      break;
    }
  }
  if (!target && S.benchCenter && st.desk.wfId && g.distanceTo(S.benchCenter) < 7) target = { bench: true, at: S.benchCenter.clone(), radius: 2 };
  st.target = target;
  if (target) {
    st.marker.position.copy(target.at).setY(0.6);
    st.marker.scale.setScalar((target.radius + 0.6) / 2.1);
    st.marker.material.opacity = 0.9;
    st.marker.material.color.set(target.bench ? 0xf0b04a : 0xc4ff3d);
  } else st.marker.material.opacity = 0;
  const wf = target?.wfId ? S.workflows.find((w) => w.id === target.wfId) : null;
  const from = st.desk.wfId ? S.workflows.find((w) => w.id === st.desk.wfId) : null;
  const name = st.desk.agent.name;
  st.hint.textContent = !target
    ? 'Drop it on a team'
    : target.bench
      ? `Take ${name} off ${from?.name || 'its team'}`
      : wf!.id === from?.id
        ? `Already on ${wf!.name}`
        : (wf!.members || []).includes(st.desk.agent.id)
          ? `Already on ${wf!.name}`
          : from && !st.copy
            ? `Move to ${wf!.name} (hold Ctrl to keep it on ${from.name} too)`
            : `Add to ${wf!.name}`;
  const r = S.root.getBoundingClientRect();
  const z = uiZoom();
  st.hint.style.transform = `translate(${(e.clientX - r.left) / z + 16}px, ${(e.clientY - r.top) / z + 12}px)`;
}

async function dropAgent(): Promise<void> {
  assertMounted(S);
  const st = S.agentDrag;
  S.agentDrag = null;
  if (!st) return;
  st.marker.parent?.remove(st.marker);
  st.marker.geometry.dispose();
  st.hint.remove();
  st.desk.group.traverse((o) => delete o.userData.dragging);
  st.desk.group.position.copy(st.home);
  const t = st.target;
  if (!t) return;
  const agentId = st.desk.agent.id;
  const from = st.desk.wfId ? structuredClone(S.workflows.find((w) => w.id === st.desk.wfId)) : null;
  if (t.bench) {
    if (!from) return;
    setMembers(from, from.members.filter((x) => x !== agentId));
    await saveWorkflow(from);
    toast(`${st.desk.agent.name} left ${from.name}`);
    return;
  }
  if (from && t.wfId === from.id) return;
  const to = structuredClone(S.workflows.find((w) => w.id === t.wfId));
  if (!to || to.members.includes(agentId)) return;
  if (from && !st.copy) {
    setMembers(from, from.members.filter((x) => x !== agentId));
    await attempt(() => PUT(`/workflows/${from.id}`, teamBody(from)));
  }
  setMembers(to, [...to.members, agentId]);
  await saveWorkflow(to);
  toast(`${st.desk.agent.name} → ${to.name}`);
}

// ---------- right-click menu ----------
function closeMenu(): void {
  S?.menu?.remove();
  if (S) S.menu = null;
}

function openMenu(e: MouseEvent, p: MapPick | null): void {
  assertMounted(S);
  closeMenu();
  const d = state.data!;
  const items: HTMLElement[] = [];
  const item = (label: string, fn: () => unknown, cls = '', ico: string | null = null) => items.push(h(`button.st-menu-item${cls ? '.' + cls : ''}`, { onclick: () => (closeMenu(), fn()) }, ico ? icon(ico, 15) : h('span', { style: { width: '15px' } }), label));
  const head = (text: string) => items.push(h('div.st-menu-head', text));
  const sep = () => items.push(h('div.st-menu-sep'));
  const addStep = async (w: TeamView, a: Agent) => {
    const copy = structuredClone(w);
    copy.steps.push({ id: Math.random().toString(36).slice(2), type: 'agent', agentId: a.id, prompt: copy.steps.length ? 'Continue from this:\n{{prev}}' : '{{input}}' });
    await saveWorkflow(copy);
    toast(`${a.name} → ${w.name}`);
  };
  const newAgent = async () => {
    const a = await attempt(() => POST<Agent>('/agents', { name: 'New agent' }));
    if (a) navigate(`#/agents/${a.id}/edit`);
  };
  if (p?.type === 'agent') {
    const a = d.agents.find((x) => x.id === p.id);
    if (!a) return;
    head(`${a.emoji || ''} ${a.name}`);
    item('Chat', () => openChat('agent', a.id), '', 'message-square');
    item('Edit agent', () => navigate(`#/agents/${a.id}/edit`), '', 'pencil');
    if (a.engine !== 'openai') item('Open in terminal', () => openTerminal(a), '', 'terminal');
    item('Clone', () => cloneAgent(a), '', 'copy');
    item('Save as preset', () => presetAgent(a), '', 'bookmark-plus');
    const others = S.workflows.filter((w) => !w.steps.some((s) => s.type === 'agent' && s.agentId === a.id));
    if (others.length) {
      sep();
      for (const w of others.slice(0, 8)) item(`Add to ${w.name}`, () => addStep(w, a), '', 'plus');
    }
    const w = p.wf ? S.workflows.find((x) => x.id === p.wf) : null;
    if (w)
      item(`Remove from ${w.name}`, async () => {
        const copy = structuredClone(w);
        copy.steps = copy.steps.filter((s) => !(s.type === 'agent' && s.agentId === a.id));
        await saveWorkflow(copy);
      });
    sep();
    item(
      'Delete agent',
      async () => {
        if (!(await confirmBox(`Delete ${a.name}? It is also taken off every team.`, { ok: 'Delete', danger: true }))) return;
        await attempt(() => DEL(`/agents/${a.id}`), `Deleted ${a.name}`);
        choose(null);
        refreshSoon(0);
        reloadWorkflows();
      },
      'danger',
      'trash-2',
    );
  } else if (p?.type === 'branch') {
    const w = S.workflows.find((x) => x.id === p.id);
    if (!w) return;
    head(w.name);
    item('Open', () => choose({ type: 'branch', id: w.id }), '', 'maximize-2');
    item('Message the team', () => openChat('team', w.id), '', 'message-square');
    item('Edit in builder', () => openBranchBuilder({ wf: w, onSaved: reloadWorkflows }), '', 'workflow');
    item('Clone team', () => cloneTeam(w, false), '', 'copy');
    item('Clone with copies of its agents', () => cloneTeam(w, true), '', 'copy');
    item('Save as preset', () => presetTeam(w), '', 'bookmark-plus');
    item('Rename', async () => {
      const name = await promptBox('Rename team', { value: w.name });
      if (name?.trim()) await saveWorkflow({ ...w, name: name.trim() });
    });
    const missing = d.agents.filter((a) => !w.steps.some((s) => s.type === 'agent' && s.agentId === a.id));
    if (missing.length) {
      sep();
      for (const a of missing.slice(0, 8)) item(`Add ${a.emoji || ''} ${a.name}`, () => addStep(w, a), '', 'user-plus');
    }
    item('Hire a new agent into it', () => navigate(`#/library?branch=${encodeURIComponent(w.id)}`), '', 'store');
    sep();
    item('Spin 45°', async () => {
      spinBranch(w.id, Math.PI / 4);
      await saveBranchPlace(w.id);
    }, '', 'rotate-cw');
    if (w.pos || typeof w.angle === 'number' || w.rot) item('Put back next to the Brain', () => saveWorkflow({ ...w, angle: null, pos: null, rot: null }), '', 'rotate-ccw');
    item(
      'Delete team',
      async () => {
        if (!(await confirmBox(`Delete the team "${w.name}"? Its agents stay in the project.`, { ok: 'Delete', danger: true }))) return;
        await attempt(() => DEL(`/workflows/${w.id}`));
        choose(null);
        reloadWorkflows();
      },
      'danger',
      'trash-2',
    );
  } else if (p?.type === 'bench') {
    head('Bench');
    item('New agent', newAgent, '', 'bot');
    item('Hire from the library', () => navigate('#/library'), '', 'library-big');
    if (S.layout?.bench) item('Put the Bench back', () => saveLayout({ bench: null }).then(() => rebuild()), '', 'rotate-ccw');
  } else {
    head('Station');
    item('New team', newBranch, '', 'git-branch');
    item('New agent', newAgent, '', 'bot');
    item('Hire from the library', () => navigate('#/library'), '', 'library-big');
    item('Ask the Brain', () => openDock(), '', 'sparkles');
    sep();
    item('Reset view', () => resetView(), '', 'rotate-ccw');
  }
  const menu = h('div.st-menu', items);
  S.root.append(menu);
  const r = S.root.getBoundingClientRect();
  const z = uiZoom();
  const x = Math.min((e.clientX - r.left) / z, r.width / z - 250);
  const y = Math.min((e.clientY - r.top) / z, r.height / z - Math.min(460, items.length * 34 + 24));
  menu.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  S.menu = menu;
}

// Right-clicking a label works like right-clicking the thing it names.
function labelPick(l: Label): MapPick | null {
  if (l.kind === 'agent') return { type: 'agent', id: l.id, wf: l.wf };
  if (l.kind === 'step') return { type: 'branch', id: l.id.split(':')[0] };
  if (l.kind === 'branch') return { type: 'branch', id: l.id };
  if (l.kind === 'bench') return { type: 'bench' };
  return null;
}

// Zoom toward the mouse pointer, so what is under it stays under it.
function zoomAt(f: number, e?: MouseEvent): void {
  assertMounted(S);
  const c = S.cam;
  const before = c.zoom;
  const after = Math.min(8, Math.max(0.3, before * f));
  if (e) {
    const r = S.renderer.domElement.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    const ground = (zoom: number) => {
      c.zoom = zoom;
      updateCamera();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(nx, ny), S!.camera);
      const p = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
    };
    const p1 = ground(before);
    const p2 = ground(after);
    if (p1 && p2) c.target.add(p1.sub(p2));
  }
  c.zoom = after;
  c.goal = null;
  updateCamera();
}

// Size the view so the whole station (branches, cards, connections) fits on screen.
function fitView(): void {
  if (!S?.world) return;
  const box = new THREE.Box3();
  S.world.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.noFit) box.expandByObject(o);
  });
  box.expandByPoint(new THREE.Vector3(-6, 0, -6)).expandByPoint(new THREE.Vector3(6, 8, 6));
  if (box.isEmpty()) return;
  const keep = { ...S.cam, target: S.cam.target.clone() };
  S.cam.view = 100;
  S.cam.zoom = 1;
  S.cam.target.set(0, 0, 0);
  updateCamera();
  let mx = 0;
  let my = 0;
  const v = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    v.set(x, y, z).project(S.camera);
    mx = Math.max(mx, Math.abs(v.x));
    my = Math.max(my, Math.abs(v.y));
  }
  // room for the top bar, the feed and the cards around the edge
  S.cam.view = 100 * Math.max(mx, my * 1.2) * 1.3;
  S.cam.zoom = keep.zoom;
  S.cam.target.copy(keep.target);
  updateCamera();
}

function resetView(instant = false): void {
  if (!S) return;
  fitView();
  S.cam.az = Math.PI / 4;
  if (instant) {
    S.cam.target.set(0, 0, 0);
    S.cam.zoom = 1;
    updateCamera();
  } else S.cam.goal = { target: new THREE.Vector3(), zoom: 1 };
}

// Center something in the part of the screen the side panel doesn't cover.
function flyTo(vec: THREE.Vector3, zoom: number): void {
  assertMounted(S);
  const z = Math.max(S.cam.zoom, zoom);
  const target = vec.clone().setY(0);
  // centre it in the free part of the screen: right of the chat window (if it's on the left), left of the side panel
  let L = 0;
  let R = S.w > 900 ? S.w - 400 : S.w;
  const cw = document.querySelector('.cw:not(.hidden)');
  if (cw) {
    const z0 = uiZoom();
    const rr = S.root.getBoundingClientRect();
    const c = cw.getBoundingClientRect();
    const cl = (c.left - rr.left) / z0;
    const cr = (c.right - rr.left) / z0;
    if (cl + (cr - cl) / 2 < S.w / 2) L = Math.max(L, cr);
    else R = Math.min(R, cl);
  }
  if (R - L < 260) {
    L = 0;
    R = S.w > 900 ? S.w - 400 : S.w;
  }
  const panelPx = S.w / 2 - (L + R) / 2;
  const unitsPerPx = S.cam.view / z / S.h;
  const right = new THREE.Vector3(Math.cos(S.cam.az), 0, -Math.sin(S.cam.az));
  target.addScaledVector(right, panelPx * unitsPerPx);
  S.cam.goal = { target, zoom: z };
}

// ---------- HUD ----------
function badge(id: string): HTMLSpanElement | null {
  const it = intInfo(id);
  if (!it) return null;
  return h('span.st-badge', { style: { '--c': it.color }, title: it.label }, mark(id, 11));
}

/** A tile in the header's CONNECTED TO row. */
interface HudTile {
  key: string;
  int?: string;
  glyph: SVGSVGElement | string;
  color: string;
  on: boolean;
  missing?: boolean;
  title: string;
  onclick: () => void;
}
function drawHud(): void {
  const d = state.data;
  if (!d || !S) return;
  setBrainLogo();
  const ints = availableIntegrations(d, S.progs);
  const needs = d.approvals.length + d.outboxPending;
  if (!S.hudBuilt) {
    S.hudBuilt = true;
    S.hudTop = h('div.st-top');
    S.feedEl = h('div.st-feed');
    S.zoomEl = h(
      'div.st-zoom',
      h('button', { title: 'Zoom in (+)', onclick: () => zoomAt(1.3) }, icon('zoom-in', 17)),
      h('button', { title: 'Zoom out (−)', onclick: () => zoomAt(0.77) }, icon('zoom-out', 17)),
      h('button', { title: 'Whole station (0)', onclick: () => resetView() }, icon('house', 17)),
    );
    S.emptyEl = h('div.st-empty-wrap');
    S.statsEl = h('div.st-stats-row');
    S.hud.append(S.hudTop, S.statsEl, S.feedEl, S.zoomEl, S.emptyEl);
  }
  // Everything that could be connected: lit when it works, grey when it doesn't (yet).
  const tiles: HudTile[] = [];
  for (const c of S.headbar?.connectors || []) {
    const look = connectorLook(c.name);
    const ok = c.status === 'connected';
    tiles.push({ key: `cc:${c.name}`, int: `cc:${c.name}`, glyph: logo(c.name, 14) || look.glyph, color: look.color, on: ok, title: `${c.name} · Claude account connector · ${ok ? 'connected' : c.status === 'needs-auth' ? 'needs sign-in (run /mcp in Claude Code)' : c.detail}`, onclick: () => navigate('#/settings?tab=mcp') });
  }
  for (const it of ints) tiles.push({ key: it.id, int: it.id, glyph: mark(it.id), color: it.color, on: it.live, title: `${it.label} · ${it.live ? 'ready' : 'installed, not running'}`, onclick: () => choose({ type: 'int', id: it.id }) });
  const missing = [
    !d.accounts.x.length && { glyph: logo('x', 13) || '𝕏', title: 'X · not connected (Connections)', href: '#/settings?tab=connections' },
    !d.accounts.telegram.configured && { glyph: logo('telegram', 13) || '✈', title: 'Telegram · not set up (Connections)', href: '#/settings?tab=connections' },
    !(d.accounts.reddit || []).length && { glyph: logo('reddit', 13) || 'r/', title: 'Reddit · not connected (Settings > Connections)', href: '#/settings?tab=connections' },
    !d.accounts.discord.configured && { glyph: logo('discord', 13) || 'D', title: 'Discord · not set up (Connections)', href: '#/settings?tab=connections' },
    !d.secrets.openrouterKey.set && { glyph: '⇄', title: 'OpenRouter · no key yet (Settings)', href: '#/settings' },
  ].filter(Boolean) as { glyph: SVGSVGElement | string; title: string; href: string }[];
  for (const m of missing) tiles.push({ key: m.title, glyph: m.glyph, color: '#555850', on: false, missing: true, title: m.title, onclick: () => navigate(m.href) });
  const seen = new Set<string>();
  // Every engine an agent (or the Brain) can run on: lit when ready, grey with a setup link when not.
  const brainP = d.settings?.brain?.provider || 'claude';
  const busyIds = new Set((d.runs || []).map((r) => r.agentId));
  const engines = [
    { id: 'claude-code', brain: 'claude', name: 'Claude Code', glyph: logo('claude', 15) || '✳', color: '#d97757', ready: d.engines['claude-code'].installed, why: d.engines['claude-code'].installed ? '' : 'not installed', find: 'Claude Code' },
    { id: 'openai', brain: 'openrouter', name: 'OpenRouter', glyph: '◇', color: '#8f94ff', ready: d.secrets.openrouterKey.set, why: d.secrets.openrouterKey.set ? '' : 'no key yet', find: 'OpenRouter key' },
    { id: 'hermes', brain: 'hermes', name: 'Hermes', glyph: '☤', color: '#d8c25a', ready: d.engines.hermes.installed, why: d.engines.hermes.installed ? '' : 'not installed', find: 'Hermes' },
    { id: 'codex', brain: 'codex', name: 'OpenAI Codex', glyph: logo('openai', 14) || '◎', color: '#e6e8e0', ready: !!(d.engines.codex?.installed && d.engines.codex.loggedIn), why: !d.engines.codex?.installed ? 'not installed' : d.engines.codex.loggedIn ? '' : 'not signed in', find: 'OpenAI Codex' },
  ].map((e) => {
    const users = d.agents.filter((a) => a.engine === e.id);
    const busy = users.some((a) => busyIds.has(a.id));
    const who = [users.length ? `${users.length} agent${users.length === 1 ? '' : 's'}` : '', brainP === e.brain ? 'the Brain' : ''].filter(Boolean).join(' + ');
    return { ...e, n: users.length + (brainP === e.brain ? 1 : 0), busy, title: `${e.name} · ${e.ready ? 'ready' : e.why}${who ? ` · used by ${who}` : ''}${e.ready ? '' : ' (click to set up)'}` };
  });
  S.clockEl ||= h('span.st-clock');
  S.tileEls = new Map();
  mount(
    S.hudTop,
    h('button.st-project', { title: 'Switch or create a project', onclick: (e) => openProjectMenu(e.currentTarget) }, d.project?.logoAt ? h('span.st-mark.logo', projectMark(d.project, 18)) : h('span.st-mark', '◢'), h('span.st-project-name', d.project?.name || 'Project'), icon('chevron-down', 14)),
    h(
      'div.st-connected',
      h('span.st-conn-label', h('span.dot.on'), 'CONNECTED TO'),
      tiles
        .filter((t) => !seen.has(t.title.split(' · ')[0].toLowerCase()) && seen.add(t.title.split(' · ')[0].toLowerCase()))
        .sort((a, b) => +b.on - +a.on || +!!a.missing - +!!b.missing)
        .map((t) => {
          const el = h(`button.st-int${t.on ? '' : '.off'}${t.missing ? '.missing' : ''}`, { style: { '--c': t.color }, title: t.title, onclick: t.onclick }, t.glyph);
          if (t.int) {
            S!.tileEls.set(t.int, el);
            const id = t.int;
            el.addEventListener('pointerenter', () => S && (S.hover = hoverForLink(id)));
            el.addEventListener('pointerleave', () => S && (S.hover = null));
          }
          return el;
        }),
    ),
    h(
      'div.st-right',
      h(
        'div.st-headless',
        h('span.st-conn-label', h(`span.dot${engines.some((e) => e.busy) ? '.busy' : '.on'}`), 'AI ENGINES'),
        engines.map((e) =>
          h(
            `button.st-engine${e.ready ? '' : '.off'}${e.busy ? '.busy' : ''}`,
            {
              style: { '--c': e.color },
              title: e.title,
              onclick: () => navigate(`#/settings?tab=general&find=${encodeURIComponent(e.find)}`),
              onpointerenter: () => S && (S.hover = hoverForEngine(e.id, brainP === e.brain, e.color)),
              onpointerleave: () => S && (S.hover = null),
            },
            e.glyph,
            e.n ? h('span.st-engine-n', String(e.n)) : null,
          ),
        ),
      ),
      S.headbar?.usages?.length ? (S.usageEl ||= h('div.st-usage')) : null,
      S.clockEl,
    ),
  );
  tickClock();
  drawUsage(false);
  drawEmpty(d);
  mount(
    S.statsEl,
    h(
      'div.st-stats',
      d.runs.length || S.active.size ? h('div.st-stat.live', h('b', String(d.runs.length + S.active.size)), 'working') : null,
      needs ? h('button.st-stat.hot', { onclick: () => document.getElementById('drawer')!.classList.toggle('hidden') }, icon('bell', 13), h('b', String(needs)), 'needs you') : null,
      d.agents.length ? h('button.st-btn', { onclick: newBranch }, icon('git-branch', 14), 'team') : null,
    ),
  );
}

// What to do first, when there is nothing on the map yet.
function drawEmpty(d: AppState): void {
  if (!S?.emptyEl) return;
  let card: HTMLDivElement | null = null;
  if (!d.agents.length)
    card = h(
      'div.st-empty',
      h('div.st-empty-title', 'Your station is empty'),
      h('p', 'Tell the Brain what you need, e.g. "make me a social media team", and it builds the team from the library. Or hire and create agents yourself.'),
      h(
        'div.row',
        h('button.btn', { onclick: () => openDock('auto', 'Make me a team for ') }, 'Ask the Brain'),
        h('a.btn.ghost', { href: '#/library' }, 'Library'),
        h('button.btn.ghost', {
          onclick: async () => {
            const a = await attempt(() => POST<Agent>('/agents', { name: 'New agent' }));
            if (a) navigate(`#/agents/${a.id}/edit`);
          },
        }, 'Create your own'),
      ),
    );
  else if (!S.workflows.length)
    card = h(
      'div.st-empty',
      h('div.st-empty-title', `${d.agents.length} agent${d.agents.length === 1 ? '' : 's'} ready`),
      h('p', 'Ask any of them something in the Brain chat, or group them into a team: a workflow where each one hands its result to the next.'),
      h('div.row', h('button.btn', { onclick: newBranch }, '+ New team'), h('button.btn.ghost', { onclick: () => openDock() }, 'Open Brain chat')),
    );
  mount(S.emptyEl, card);
}

function buildWires(): void {
  assertMounted(S);
  const agentsById = new Map((state.data?.agents || []).map((a) => [a.id, a]));
  S.links2d = [];
  for (const node of [...S.nodes, ...(S.benchNodes || [])]) {
    // refresh agent links (connectors may have loaded since the map was built)
    if (node.kind === 'agent') {
      const wf = node.wfId ? S.workflows.find((w) => w.id === node.wfId) : null;
      node.links = wf ? stepLinks(wf.steps[node.index], agentsById, wf) : agentLinks(agentsById.get(node.agentId));
    }
    for (const id of node.links) S.links2d.push({ intId: id, node, flash: 0 });
  }
  // combined: one wire per connection per team, and one to the Bench
  S.links2dAll = [];
  const bundle = (nodes: MapNode[], anchor: THREE.Object3D, lift: number) => {
    const by = new Map<string, MapNode[]>();
    for (const n of nodes) for (const id of n.links) by.set(id, [...(by.get(id) || []), n]);
    for (const [intId, members] of by) S!.links2dAll!.push({ intId, node: null, anchor, lift, members, flash: 0 });
  };
  for (const [, b] of S.branches) bundle(b.nodes, b.group, 1.9);
  if (S.bench && S.benchNodes?.length) bundle(S.benchNodes, S.bench, 1.4);
}

// Brand-ish tiles for connectors on your Claude account (no logos bundled: letters in brand colors).
function connectorLook(name: string): { glyph: string; color: string } {
  const n = name.toLowerCase();
  const map: [RegExp, string, string][] = [
    [/gmail/, 'M', '#ea4335'],
    [/calendar/, '31', '#4285f4'],
    [/drive/, '▲', '#34a853'],
    [/notion/, 'N', '#e6e8e0'],
    [/higgsfield/, 'H', '#c4ff3d'],
    [/claude docs|docs/, 'CD', '#d97757'],
    [/slack/, '#', '#e01e5a'],
    [/linear/, 'L', '#5e6ad2'],
    [/atlassian|jira|confluence/, 'A', '#2684ff'],
    [/intercom/, 'I', '#1f8ded'],
    [/figma/, 'F', '#f24e1e'],
    [/github/, 'GH', '#e6e8e0'],
    [/stripe/, 'S', '#635bff'],
    [/canva/, 'C', '#00c4cc'],
  ];
  for (const [re, glyph, color] of map) if (re.test(n)) return { glyph, color };
  return { glyph: name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '⌁', color: '#a9d3e2' };
}

const USAGE_LOOK: Record<string, { brand?: string; glyph: string; color: string }> = { claude: { brand: 'claude', glyph: '✳', color: '#d97757' }, openrouter: { glyph: '◇', color: '#8f94ff' }, codex: { brand: 'openai', glyph: '◎', color: '#e6e8e0' } };
function drawUsage(animate: boolean): void {
  const list = S?.headbar?.usages || [];
  if (!S?.usageEl || !list.length) return;
  const u = list[(S.usageIdx || 0) % list.length];
  const look = USAGE_LOOK[u.id] || { glyph: '•', color: '#aaa' };
  const meter = (m: UsageMeter) =>
    h(
      'div.st-meter',
      { title: m.resetsAt ? `resets ${new Date(m.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : m.text || '' },
      h('span', m.label),
      m.percent != null ? h('div.st-meter-bar', h('i', { style: { width: `${m.percent}%`, background: m.percent >= 80 ? 'var(--amber)' : 'var(--accent)' } })) : null,
      h('b', m.percent != null ? `${m.percent}%` : m.text || '–'),
    );
  mount(
    S.usageEl,
    h(
      `div.st-meters${animate ? '.st-usage-in' : ''}`,
      h('span.st-usage-who', { style: { '--c': look.color }, title: `${u.name} usage${list.length > 1 ? ' · switches every 6 s' : ''}` }, (look.brand && logo(look.brand, 14)) || look.glyph),
      u.meters.map(meter),
      list.length > 1 ? h('span.st-usage-dots', list.map((_, i) => h(`i${i === (S!.usageIdx || 0) % list.length ? '.on' : ''}`))) : null,
    ),
  );
}

function tickClock(): void {
  if (S?.clockEl) S.clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function loadHeadbar(): Promise<void> {
  const hb = await GET<Headbar>('/headbar').catch(() => null);
  if (S && hb) {
    S.headbar = hb;
    drawHud();
    if (S.world) buildWires();
  }
}

function feedPush(text: string, kind = 'run'): void {
  if (!S) return;
  S.feed.unshift({ text, kind, ts: Date.now() });
  S.feed = S.feed.slice(0, 4);
  drawFeed();
}

function drawFeed(): void {
  if (!S?.feedEl) return;
  S.feedEl.classList.toggle('hidden', !S.feed.length);
  mount(
    S.feedEl,
    h('div.st-feed-head', h('span.dot.busy'), 'LIVE'),
    S.feed.map((f, i) => h('div.st-feed-item', { style: { opacity: String(1 - i * 0.12) }, class: f.kind === 'error' ? 'err' : '' }, h('span.st-feed-time', ago(f.ts)), f.text)),
  );
}

async function reloadWorkflows(): Promise<void> {
  if (!S) return;
  const [wfs, runs] = await Promise.all([GET<TeamListing[]>('/workflows').catch(() => S!.workflows), GET<WorkflowRun[]>('/workflow-runs').catch(() => S!.wfRuns)]);
  if (!S) return;
  S.workflows = wfs.map(teamView);
  for (const w of wfs) {
    if (w.state) S.teamState[w.id] = w.state;
    if (w.last) S.teamLast[w.id] = w.last;
  }
  S.wfRuns = runs;
  shareTeams();
  if (signature() !== S.signature) rebuild();
  else updateStatuses();
  drawHud();
  if (S.selected?.type === 'branch') renderPanel();
}


// What gets saved: a step list keeps its own steps (approvals, posts...), with the members swapped in.
function teamBody(wf: TeamView): Team {
  const { stepList = [], ...team } = wf;
  team.members = [...new Set((wf.steps || []).filter((x) => x.type === 'agent' && x.agentId).map((x) => x.agentId!))];
  if (team.lead && !team.members.includes(team.lead)) team.lead = null;
  return { ...team, steps: teamSteps({ steps: stepList, members: team.members }) } as Team;
}
async function saveWorkflow(wf: TeamView): Promise<Team | undefined> {
  const r = await attempt(() => PUT<Team>(`/workflows/${wf.id}`, teamBody(wf)));
  if (r) await reloadWorkflows();
  return r;
}

// New branch: the builder (name, agents, access, or auto-build).
function newBranch(): void {
  openBranchBuilder({
    onSaved: async (wf: Team) => {
      await reloadWorkflows();
      choose({ type: 'branch', id: wf.id });
    },
  });
}

// ---------- selection & panels ----------
function choose(p: MapPick | null): void {
  if (!S) return;
  S.selected = p;
  S.chat = null;
  for (const l of S.labelEls) l.el.classList.toggle('sel', !!p && l.kind === p.type && l.id === p.id && (!p.wf || !l.wf || l.wf === p.wf));
  if (!p) {
    // slide out, then hide (unless something was picked meanwhile)
    if (!S.panel.classList.contains('hidden') && !S.panelClosing) {
      const panel = S.panel;
      S.panelClosing = slideOut(panel, { x: 40, duration: 230 }).then(() => {
        if (S && !S.selected) panel.classList.add('hidden');
        if (S) S.panelClosing = null;
      });
    }
    return;
  }
  if (p.type === 'branch') openChat('team', p.id, { focus: false });
  if (p.type === 'agent') openChat('agent', p.id, { focus: false });
  if (p.type === 'agent') {
    const desk = S.desks.find((x) => x.agent.id === p.id && (!p.wf || x.wfId === p.wf)) || S.desks.find((x) => x.agent.id === p.id);
    if (desk) flyTo(desk.group.getWorldPosition(new THREE.Vector3()), 2.2);
  } else if (p.type === 'branch') {
    const b = S.branches.get(p.id);
    if (b) flyTo(b.group.position.clone(), Math.max(0.9, 1.9 - b.radius * 0.08));
  } else if (p.type === 'brain') flyTo(new THREE.Vector3(), 1);
  // open: slide in from the right; already open (another team or agent): a small move, not a jump
  const wasOpen = !S.panel.classList.contains('hidden') && !S.panelClosing;
  S.panel.getAnimations().forEach((a) => a.cancel());
  S.panelClosing = null;
  S.panel.classList.remove('hidden');
  if (wasOpen) slideIn(S.panel, { x: 14, duration: 280 });
  else slideIn(S.panel, { x: 44, duration: 420, blur: 4 });
  renderPanel();
}

function panelHead(...children: Child[]): HTMLDivElement {
  return h('div.st-panel-head', ...children, h('button.icon-btn', { onclick: () => choose(null), 'aria-label': 'Close' }, '✕'));
}

function connectionList(ids: Set<string>): HTMLElement {
  assertMounted(S);
  const d = state.data!;
  const avail = new Map(availableIntegrations(d, S.progs).map((i) => [i.id, i]));
  if (!ids.size) return h('p.hint', 'No outside connections. It works from its instructions and knowledge.');
  return h(
    'div.st-conns',
    [...ids].map((id) => {
      const info = intInfo(id);
      if (!info) return null;
      const a = avail.get(id);
      const st = !a ? 'not set up' : a.live ? 'ready' : 'not running';
      return h('button.st-conn', { class: !a ? 'missing' : a.live ? 'ok' : 'off', onclick: () => choose({ type: 'int', id }) }, h('span.st-badge', { style: { '--c': info.color } }, mark(id, 12)), h('span.grow', info.label), h('span.st-conn-st', st));
    }),
  );
}

async function renderPanel(): Promise<void> {
  const p = S?.selected;
  const d = state.data;
  if (!p || !d) return;
  assertMounted(S);
  if (p.type === 'agent') return renderAgentPanel(p.id, p.wf);
  if (p.type === 'branch') return renderBranchPanel(p.id);
  if (p.type === 'bench') {
    const used = new Set(S.workflows.flatMap((w) => w.members || []));
    const bench = d.agents.filter((a) => !used.has(a.id));
    mount(
      S.panel,
      panelHead(h('div.grow', h('div.label', 'Bench'), h('div.st-panel-title', `${bench.length} agents not on a team`))),
      h(
        'div.st-panel-body',
        h('p.hint', 'Agents not in a team yet. Drag one onto a team on the map, or open it and add it to a team.'),
        h('div.list', bench.map((a) => h('div.list-item', { style: { cursor: 'pointer' }, onclick: () => choose({ type: 'agent', id: a.id }) }, avatar(a), h('div.grow', h('div.title', a.name), h('div.hint', a.specialty || ''))))),
        h('div.row.mt', h('a.btn.ghost.small', { href: '#/library' }, 'Hire more'), h('button.btn.ghost.small', { onclick: async () => {
          const a = await attempt(() => POST<Agent>('/agents', { name: 'New agent' }));
          if (a) navigate(`#/agents/${a.id}/edit`);
        } }, '+ New agent')),
      ),
    );
    return;
  }
  if (p.type === 'brain') {
    const proj: Partial<Project> = d.project || {};
    const info = h('div', h('p.hint', 'Reading the Brain folder…'));
    // what the project is about, and its logo (shown here, on the start screen, in the project menu and in the globe)
    const aboutBox = h('div.st-about');
    const drawAbout = (summary: { text: string; from: string | null } | null, editing = false) => {
      const logoBox = h(
        'div.st-about-logo',
        { title: proj.logoAt ? 'Change the logo' : 'Add a logo', onclick: () => proj.id && pickLogo({ id: proj.id, name: proj.name || '' }).then((ok) => ok && S?.selected?.type === 'brain' && setTimeout(renderPanel, 300)) },
        proj.logoAt ? projectMark(proj as Project, 64) : h('span.st-about-add', icon('image', 20), 'Logo'),
      );
      const text = summary?.text || '';
      const editor = h('textarea', { rows: 4, value: proj.description || text, placeholder: 'What is this project? Who is it for, what should come out of it?' });
      const save = async () => {
        if (!proj.id) return;
        const r = await attempt(() => PUT<Project>(`/projects/${proj.id}`, { description: editor.value }), 'Saved');
        if (r) {
          refreshSoon(0);
          drawAbout({ text: editor.value.trim(), from: 'description' });
        }
      };
      mount(
        aboutBox,
        h(
          'div.st-about-top',
          logoBox,
          h(
            'div.grow',
            editing
              ? h('div.col', editor, h('div.row', { style: { gap: '6px' } }, h('button.btn.small', { onclick: save }, 'Save'), h('button.btn.ghost.small', { onclick: () => drawAbout(summary) }, 'Cancel')))
              : text
                ? [h('p.st-about-text', text), summary?.from && summary.from !== 'description' ? h('div.hint', `from ${summary.from}`) : null]
                : h('p.hint', 'No description yet. Say what the project is about, or ask the Brain to write PROJECT.md.'),
          ),
        ),
        editing
          ? null
          : h(
              'div.row.st-about-actions',
              h('button.btn.ghost.tiny', { onclick: () => drawAbout(summary, true) }, icon('pencil', 12), text ? 'Edit description' : 'Add a description'),
              h('button.btn.ghost.tiny', { onclick: () => proj.id && pickLogo({ id: proj.id, name: proj.name || '' }).then((ok) => ok && S?.selected?.type === 'brain' && setTimeout(renderPanel, 300)) }, icon('image', 12), proj.logoAt ? 'Change logo' : 'Add logo'),
              proj.logoAt ? h('button.btn.ghost.tiny', { onclick: () => proj.id && removeLogo({ id: proj.id, name: proj.name || '' }).then(() => S?.selected?.type === 'brain' && setTimeout(renderPanel, 300)) }, 'Remove logo') : null,
            ),
      );
      if (editing) setTimeout(() => editor.focus(), 30);
    };
    drawAbout(proj.description ? { text: proj.description, from: 'description' } : null);
    mount(
      S.panel,
      panelHead(
        proj.logoAt ? h('span.st-proj-logo', projectMark(proj as Project, 34)) : h('span.st-badge.lg', { style: { '--c': '#c4ff3d' } }, icon('brain', 18)),
        h('div.grow', h('div.label', 'Project Brain'), h('div.st-panel-title', proj.name || 'Project')),
      ),
      h(
        'div.st-panel-body',
        aboutBox,
        h('div.st-mini-stats', h('div', h('b', String(d.agents.length)), 'agents'), h('div', h('b', String(S.workflows.length)), 'teams'), h('div', h('b', String(d.runs.length + S.active.size)), 'working')),
        h('button.btn.small.st-ask-brain', { onclick: () => openDock() }, icon('sparkles', 14), 'Ask the Brain'),
        h('div.label.mt-lg', 'Brain folder'),
        h('div.hint.mono', { style: { overflowWrap: 'anywhere', marginTop: '6px' } }, proj.brainPath || ''),
        h(
          'div.row.mt',
          { style: { gap: '6px' } },
          h('button.btn.ghost.small', { onclick: () => attempt(() => POST('/brain/open', {})) }, icon('folder', 14), 'Open folder'),
          h('button.btn.ghost.small', { onclick: () => attempt(() => POST('/brain/open', { app: 'vscode' })) }, icon('external-link', 14), 'VS Code'),
          h('button.btn.ghost.small', {
            onclick: async () => {
              const name = await promptBox('New note in the Brain', { value: 'note.md' });
              if (!name) return;
              const content = await promptBox(name, { multiline: true, placeholder: 'Anything the agents should know about this project.' });
              if (content == null) return;
              await attempt(() => POST('/brain/note', { name, content }), 'Saved to notes/');
              if (S?.selected?.type === 'brain') renderPanel();
            },
          }, icon('pen-line', 14), 'Add note'),
        ),
        info,
        h('div.label.mt-lg', 'Teams'),
        h(
          'div.list',
          S.workflows.map((wf, i) => h('div.list-item', { style: { cursor: 'pointer' }, onclick: () => choose({ type: 'branch', id: wf.id }) }, h('span.st-dot', { style: { '--c': wfColor(wf, i) } }), h('div.grow', h('div.title', wf.name), h('div.hint', wf.description || `${(wf.members || []).length} members`)), S!.active.has(wf.id) ? h('span.dot.busy') : null)),
          !S.workflows.length ? h('p.empty', 'No teams yet.') : null,
        ),
        d.approvals.length ? [h('div.label.mt-lg', 'Needs you'), h('div.col', d.approvals.map(approvalCard))] : null,
        h('div.row.mt-lg', h('button.btn.ghost.small', { onclick: newBranch }, icon('git-branch', 14), 'New team')),
      ),
    );
    GET<BrainInfo>('/brain')
      .then((bi) => {
        if (S?.selected?.type !== 'brain') return;
        if (!proj.description && bi.summary?.text) drawAbout(bi.summary);
        mount(
          info,
          bi.git
            ? h(
                'div.st-conn.ok.mt',
                logo('github', 16) || icon('git-branch', 16),
                h('div.grow', h('div', bi.git.url ? h('a', { href: bi.git.url, target: '_blank' }, bi.git.url.replace('https://github.com/', '')) : 'Local git repo'), h('div.hint', `${bi.git.branch} · ${bi.git.last}${bi.git.changes ? ` · ${bi.git.changes} changed` : ''}`)),
                h('button.btn.tiny.ghost', { onclick: () => attempt(() => POST<{ message: string }>('/brain/pull'), (r) => r.message) }, 'Pull'),
              )
            : null,
          h('div.hint.mt', `${bi.files} files · ${bi.sizeMB} MB`),
          h(
            'div.st-files',
            bi.entries.map((e) => h('div.st-file', icon(e.dir ? 'folder' : 'pen-line', 13), e.name)),
          ),
        );
      })
      .catch((e: Error) => mount(info, h('p.red.hint', e.message)));
    return;
  }
  if (p.type === 'int') {
    const it = availableIntegrations(d, S.progs).find((x) => x.id === p.id) || ({ ...intInfo(p.id), live: false, missing: true } as AvailableIntegration);
    if (!it?.label) return choose(null);
    const agentsUsing = d.agents.filter((a) => agentLinks(a).has(it.id));
    const branchesUsing = S.workflows.filter((w) => S!.branches.get(w.id)?.links.has(it.id));
    const prog = it.program;
    mount(
      S.panel,
      panelHead(h('span.st-badge.lg', { style: { '--c': it.color } }, mark(it.id, 18)), h('div.grow', h('div.label', it.mcp ? 'MCP server' : prog ? 'Program' : 'Service'), h('div.st-panel-title', it.label))),
      h(
        'div.st-panel-body',
        h('p', h('span', { class: `pill ${it.live ? 'ok' : it.missing ? 'bad' : ''}` }, it.missing ? 'not set up' : it.live ? (prog?.serviceUrl ? `running · ${prog.serviceUrl}` : prog && !prog.cli ? 'running' : 'ready') : 'installed, not running'), prog?.version ? h('span.hint', ` v${prog.version}`) : null),
        h('div.label.mt', `Teams using it (${branchesUsing.length})`),
        h('div.list', branchesUsing.map((w) => h('div.list-item', { style: { cursor: 'pointer' }, onclick: () => choose({ type: 'branch', id: w.id }) }, h('div.grow', w.name)))),
        h('div.label.mt', `Agents with access (${agentsUsing.length})`),
        h('div.list', agentsUsing.map((a) => h('div.list-item', { style: { cursor: 'pointer' }, onclick: () => choose({ type: 'agent', id: a.id }) }, avatar(a), h('div.grow', a.name)))),
        h(
          'div.row.mt',
          prog && !prog.cli && (prog.exe || prog.shortcut) ? h('button.btn.small', { onclick: () => attempt(() => POST<{ message: string }>('/programs/launch', { program: prog.id }), (r) => r.message) }, 'Start') : null,
          prog?.serviceUrl ? h('a.btn.ghost.small', { href: prog.serviceUrl, target: '_blank' }, 'Open') : null,
          ['x', 'telegram', 'discord'].includes(it.id) ? h('a.btn.ghost.small', { href: '#/settings?tab=connections' }, 'Connections') : null,
          it.mcp ? h('a.btn.ghost.small', { href: '#/settings?tab=mcp' }, 'Tools & MCP') : null,
          ['openrouter', 'lmstudio', 'ollama'].includes(it.id) ? h('a.btn.ghost.small', { href: '#/settings' }, 'Settings') : null,
        ),
      ),
    );
  }
}

// Team panel: the goal, members and lead, what it can reach, its routine, and the team chat.
function setMembers(wf: TeamView, members: string[]): void {
  wf.members = members;
  wf.steps = members.map((id) => ({ type: 'agent', agentId: id }));
  if (wf.lead && !members.includes(wf.lead)) wf.lead = null;
}

// Clone / save as preset, for agents and teams.
async function cloneAgent(a: Agent): Promise<Agent | undefined> {
  const c = await attempt(() => POST<Agent>(`/agents/${a.id}/duplicate`), `Cloned ${a.name}`);
  if (c) refreshSoon(0);
  return c;
}
async function cloneTeam(w: TeamView, withAgents: boolean): Promise<void> {
  const c = await attempt(() => POST<Team>(`/workflows/${w.id}/clone`, { withAgents }), withAgents ? `Cloned ${w.name} with copies of its agents` : `Cloned ${w.name}`);
  if (!c) return;
  if (withAgents) refreshSoon(0);
  await reloadWorkflows();
  choose({ type: 'branch', id: c.id });
}
const presetAgent = (a: Agent) => attempt(() => POST(`/presets/agent/${a.id}`), `Saved ${a.name} as a preset (Library › Your presets)`);
const presetTeam = (w: TeamView) => attempt(() => POST(`/presets/team/${w.id}`), `Saved ${w.name} and its agents as a preset (Library › Your presets)`);

// What an agent is doing right now, in words ("Blender · rendering the scene", "thinking…").
function nowText(agentId: string, wfId?: string): { st: 'needs' | 'idle' | 'working'; text: string } {
  assertMounted(S);
  const d = state.data!;
  const desk = S.desks.find((x) => x.agent.id === agentId && (!wfId || x.wfId === wfId)) || S.desks.find((x) => x.agent.id === agentId);
  const act = desk?.act;
  if (d.approvals.some((x) => x.agentId === agentId)) return { st: 'needs', text: 'Waiting for your OK' };
  if (!d.runs.some((r) => r.agentId === agentId)) return { st: 'idle', text: '' };
  if (act?.kind === 'tool') return { st: 'working', text: [act.app, act.action].filter(Boolean).join(' · ') + (act.detail ? `: ${act.detail}` : '') };
  return { st: 'working', text: 'Thinking…' };
}

function renderBranchPanel(id: string): void {
  assertMounted(S);
  const d = state.data!;
  const wf0 = S.workflows.find((w) => w.id === id);
  if (!wf0) return choose(null);
  const wf = structuredClone(wf0);
  const i = S.workflows.indexOf(wf0);
  const c = wfColor(wf, i);
  const byId = new Map(d.agents.map((a) => [a.id, a]));
  if (!['members', 'setup'].includes(S.teamTab!)) S.teamTab = 'members';
  const ts = S.teamState?.[id] || { working: [], queued: [] };
  const members = wf.members.map((mid) => byId.get(mid)).filter(Boolean) as Agent[];
  const nameOf = (mid: string) => byId.get(mid)?.name || 'Agent';
  const statusLine = ts.working.length
    ? h('span.st-team-live', h('span.dot.busy'), `${ts.working.map(nameOf).join(', ')} working${ts.queued.length ? ` · ${ts.queued.length} waiting` : ''}`)
    : h('span.hint', members.length ? 'Quiet · waiting for a message' : 'No members yet');
  const mention = (a: Agent) => openChat('team', id).mention?.(a.name);

  // ---- Members tab ----
  const membersTab = () => {
    const others = d.agents.filter((a) => !wf.members.includes(a.id));
    let addId = others[0]?.id || '';
    return [
      h('p.hint', 'Everyone sees the whole chat. Your messages go to the lead (★) first, or to whoever you @mention. Members hand work to each other with @Name.'),
      h(
        'div.st-members',
        members.map((a) => {
          const isLead = wf.lead === a.id;
          const now = nowText(a.id, id);
          const st = ts.working.includes(a.id) ? 'working' : ts.queued.includes(a.id) ? 'queued' : now.st;
          return h(
            `div.st-member.${st}`,
            h('div.st-member-av', avatar(a), isLead ? h('span.st-member-star', { title: 'Team lead' }, '★') : null),
            h(
              'div.grow',
              h('div.st-member-name', { onclick: () => choose({ type: 'agent', id: a.id, wf: id }) }, a.name, isLead ? h('span.tc-lead', 'lead') : null),
              h('div.st-member-now', st === 'working' ? [h('span.dot.busy'), ' ', now.text || 'Working…'] : st === 'queued' ? 'Up next' : st === 'needs' ? [h('span.dot.warn'), ' Waiting for your OK'] : a.specialty || 'Ready'),
              h('div.st-member-model', modelChip(a, { compact: true, onChange: () => renderBranchPanel(id) })),
            ),
            h(
              'div.st-member-actions',
              h('button', { title: `Write to ${a.name} in the team chat`, onclick: () => mention(a) }, '@'),
              h('button', { title: isLead ? 'Remove as lead' : 'Make lead: your messages go to them first', class: isLead ? 'on' : '', onclick: () => saveWorkflow({ ...wf, lead: isLead ? null : a.id }) }, '★'),
              h('button', { title: 'Take off this team (stays in the project)', onclick: () => (setMembers(wf, wf.members.filter((x) => x !== a.id)), saveWorkflow(wf)) }, '✕'),
            ),
          );
        }),
        !members.length ? h('p.empty', 'No agents yet. Add one below, hire from the Library, or ask the Brain.') : null,
      ),
      h('div.label.mt-lg', 'Add someone'),
      others.length
        ? h(
            'div.row.nowrap.mt',
            h('div.grow', dropdown(others.map((a) => ({ value: a.id, label: `${a.emoji || ''} ${a.name}` })), addId, (v) => (addId = v))),
            h('button.btn.small', { onclick: () => addId && (setMembers(wf, [...wf.members, addId]), saveWorkflow(wf)) }, icon('user-plus', 14), 'Add'),
          )
        : h('p.hint', 'Every agent in this project is already on it.'),
      h(
        'div.row.mt',
        { style: { gap: '6px', flexWrap: 'wrap' } },
        h('button.btn.ghost.small', { onclick: () => navigate(`#/library?branch=${encodeURIComponent(id)}`) }, icon('store', 14), 'Hire from the Library'),
        h('button.btn.ghost.small', { onclick: () => openDock('auto', `For the team "${wf.name}": add `) }, icon('brain', 14), 'Ask the Brain'),
      ),
      h('p.hint.mt', 'Tip: drag an agent onto this team on the map to add it (hold Ctrl to also keep it on its other team).'),
    ];
  };

  // ---- Setup tab ----
  const setupTab = () => {
    const name = h('input', { value: wf.name });
    const desc = h('textarea', { rows: 3, value: wf.description || '', placeholder: "The team's goal, e.g. grow our X account with daily posts" });
    const color = h('input', { type: 'color', value: c, style: { width: '40px', height: '34px', padding: '2px', background: 'var(--panel)', border: '1px solid var(--line-2)' } });
    const saveMeta = () => saveWorkflow({ ...wf, name: name.value.trim() || wf.name, description: desc.value.trim(), color: color.value });
    name.addEventListener('change', saveMeta);
    desc.addEventListener('change', saveMeta);
    color.addEventListener('change', saveMeta);
    let accessTimer: ReturnType<typeof setTimeout> | null = null;
    const saveAccess = (patch: Partial<TeamAccess>) => {
      wf.access = { toolGroups: wf.access?.toolGroups || [], mcpServers: wf.access?.mcpServers || [], ...patch };
      clearTimeout(accessTimer ?? undefined);
      accessTimer = setTimeout(() => saveWorkflow(wf), 500);
    };
    wf.schedule ||= { type: 'none' };
    const routineEl = h('div');
    const drawRoutine = () => {
      const sch = wf.schedule!;
      const time = h('input', { type: 'time', value: sch.time || '09:00', style: { width: '110px' } });
      const msg = h('input', { value: sch.input || '', placeholder: 'What the team should do each time' });
      const save = () => {
        wf.schedule = { ...sch, time: time.value, input: msg.value };
        wf.enabled = wf.schedule.type !== 'none';
        saveWorkflow(wf);
      };
      time.addEventListener('change', save);
      msg.addEventListener('change', save);
      mount(
        routineEl,
        h('div.row', { style: { gap: '8px' } }, h('div.seg', ['none', 'daily'].map((t) => h(`button${sch.type === t ? '.on' : ''}`, { onclick: () => ((wf.schedule = { ...sch, type: t }), (wf.enabled = t !== 'none'), saveWorkflow(wf), drawRoutine()) }, t === 'none' ? 'Off' : 'Every day'))), sch.type === 'daily' ? time : null),
        sch.type === 'daily' ? h('div.mt', msg) : null,
      );
    };
    drawRoutine();
    return [
      h('div.label', 'Name and goal'),
      h('div.row.nowrap.mt', h('div.grow', name), color),
      h('div.mt', desc),
      h('p.hint', 'Every member reads the goal before it answers in the chat.'),
      h('div.label.mt-lg', 'Team skills'),
      h('p.hint', 'Every member gets these while it works for this team (on top of its own and the project\'s).'),
      h('div.mt', skillPicker(wf.skills || [], (v) => saveWorkflow({ ...wf, skills: v }), { inherited: (d.project?.skills || []).map((slug) => ({ slug, from: 'project' })), empty: 'No team skills yet.' })),
      h('div.label.mt-lg', 'Extra access while working for this team'),
      h('p.hint', 'Members get these on top of their own tools.'),
      h('div.mt', chipSet(d.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description })), wf.access?.toolGroups || [], (v) => saveAccess({ toolGroups: v }))),
      (d.mcpServers || []).length ? h('div.mt', chipSet(d.mcpServers, wf.access?.mcpServers || [], (v) => saveAccess({ mcpServers: v }))) : null,
      h('div.label.mt-lg', 'Connections the team can reach'),
      connectionList(S!.branches.get(id)?.links || new Set()),
      h('div.label.mt-lg', 'Daily routine'),
      h('p.hint', 'The team gets this message on its schedule, as if you wrote it in the chat.'),
      routineEl,
      h('div.label.mt-lg', 'On the map'),
      h('p.hint', 'Drag the team to move it anywhere. Shift+drag spins it.'),
      h(
        'div.row.mt',
        { style: { gap: '6px', flexWrap: 'wrap' } },
        h('button.btn.ghost.small', { onclick: async () => (spinBranch(id, Math.PI / 4), await saveBranchPlace(id)) }, icon('rotate-cw', 14), 'Spin 45°'),
        wf.pos || wf.rot ? h('button.btn.ghost.small', { onclick: () => saveWorkflow({ ...wf, pos: null, rot: null, angle: null }) }, icon('rotate-ccw', 14), 'Put back next to the Brain') : null,
        h('button.btn.ghost.small', { onclick: () => S!.branches.get(id) && flyTo(S!.branches.get(id)!.group.position.clone(), 1.6) }, icon('zoom-in', 14), 'Zoom to it'),
      ),
      h(
        'div.row.mt-lg',
        h('button.btn.ghost.small', { onclick: () => openBranchBuilder({ wf: S!.workflows.find((w) => w.id === id), onSaved: reloadWorkflows }) }, icon('workflow', 14), 'Open the team builder'),
      ),
      h('div.label.mt-lg', 'Copy it'),
      h(
        'div.row.mt',
        { style: { gap: '6px', flexWrap: 'wrap' } },
        h('button.btn.ghost.small', { title: 'A new team with the same members and settings', onclick: () => cloneTeam(wf0, false) }, icon('copy', 14), 'Clone team'),
        h('button.btn.ghost.small', { title: 'A new team with copies of every member', onclick: () => cloneTeam(wf0, true) }, icon('copy', 14), 'Clone with its agents'),
        h('button.btn.ghost.small', { title: 'Keep the team and its agents as a template for any project', onclick: () => presetTeam(wf0) }, icon('bookmark-plus', 14), 'Save as preset'),
      ),
      h(
        'div.row.mt-lg',
        { style: { gap: '6px' } },
        historyButton('team', id, () => void reloadWorkflows().then(() => renderBranchPanel(id))),
        h('button.btn.danger.tiny', {
          onclick: async () => {
            if (!(await confirmBox(`Delete the team "${wf.name}"? Its agents stay in the project, the team chat is removed.`, { ok: 'Delete', danger: true }))) return;
            await attempt(() => DEL(`/workflows/${id}`));
            choose(null);
            reloadWorkflows();
          },
        }, 'Delete team'),
      ),
    ];
  };

  const tabBtn = (tid: string, label: string, n?: number) => h(`button${S!.teamTab === tid ? '.on' : ''}`, { onclick: () => ((S!.teamTab = tid), renderBranchPanel(id)) }, label, n != null ? h('span.st-tab-n', String(n)) : null);
  const body = S.teamTab === 'setup' ? setupTab() : membersTab();
  mount(
    S.panel,
    panelHead(
      h('span.st-dot', { style: { '--c': c } }),
      h('div.grow', h('div.label', 'Team · group chat'), h('div.st-panel-title', wf.name), h('div.st-team-status', statusLine)),
    ),
    h(
      'div.st-panel-body',
      wf.description ? h('p.st-team-goal', wf.description) : null,
      // faces of everyone on the team: who's working pulses, the lead has a star
      h(
        'div.st-team-faces',
        members.map((a) =>
          h(
            `button.st-face${ts.working.includes(a.id) ? '.working' : ''}`,
            { title: `${a.name}${wf.lead === a.id ? ' · lead' : ''}${ts.working.includes(a.id) ? ' · working' : ''}`, onclick: () => mention(a) },
            avatar(a),
            wf.lead === a.id ? h('span.st-member-star', '★') : null,
          ),
        ),
        h('button.st-face.add', { title: 'Add someone', onclick: () => ((S!.teamTab = 'members'), renderBranchPanel(id)) }, icon('user-plus', 15)),
      ),
      h('button.btn.small.st-open-chat', { onclick: () => openChat('team', id) }, icon('message-square', 14), 'Open the team chat'),
      h('div.tabs.st-tabs', tabBtn('members', 'Members', members.length), tabBtn('setup', 'Setup')),
      h('div.st-tab-body', body),
    ),
  );
}

// The agent's model, with its version, and how it signs in. Switch it with the chip.
const AUTH_NAMES: Record<string, string> = { login: 'Claude login (subscription)', anthropic: 'Anthropic API key', openrouter: 'OpenRouter key' };
function modelSection(a: Agent): HTMLDivElement {
  const box = h('div.st-model');
  const draw = () => {
    const mi = modelInfo(a);
    mount(
      box,
      h('div.label', 'Model'),
      h('div.st-model-now', (mi.brand && logo(mi.brand, 22)) || icon('cpu', 22), h('div.grow', h('div.st-model-name', mi.name, mi.latest ? h('span.model-latest', 'always latest') : null), h('div.hint', mi.where))),
      h('div.st-model-row', h('span.hint', 'Switch'), modelChip(a, { onChange: draw })),
      a.engine === 'claude-code'
        ? h(
            'div.st-model-row',
            h('span.hint', 'Sign in with'),
            dropdown(Object.entries(AUTH_NAMES).map(([value, label]) => ({ value, label })), a.claudeAuth || 'login', async (v) => {
              if (await attempt(() => PUT(`/agents/${a.id}`, { claudeAuth: v }), 'Saved')) {
                a.claudeAuth = v;
                refreshSoon(0);
                draw();
              }
            }),
          )
        : null,
      a.lastModel ? h('div.st-model-last', icon('circle-check', 13), 'Last run used ', h('b', a.lastModel), h('span.hint', ` · ${ago(a.lastModelAt)}`)) : h('div.hint', 'Not run yet. After the first run you see the exact model it used.'),
    );
  };
  draw();
  return box;
}

// Agent panel: who it is, which branches it's on, what it can reach, and a live mini chat.
async function renderAgentPanel(id: string, wfId?: string): Promise<void> {
  const d = state.data!;
  const a = d.agents.find((x) => x.id === id);
  if (!a) return choose(null);
  const chats = await GET<ChatSummary[]>(`/agents/${id}/chats`).catch((): ChatSummary[] => []);
  if (S?.selected?.id !== id) return;
  const chat = chats[0] ? await GET<Chat>(`/agents/${id}/chats/${chats[0].id}`).catch(() => null) : null;
  if (S?.selected?.id !== id) return;
  S.chat = chat ? { agentId: id, id: chat.id, items: chat.items } : { agentId: id, id: null, items: [] };
  const onBranches = S.workflows.filter((w) => (w.members || []).includes(id));
  const others = S.workflows.filter((w) => !onBranches.includes(w));
  let addTo = others[0]?.id || '';
  const input = h('textarea', { rows: 2, placeholder: `Message ${a.name}…  (Enter to send)` });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMini(input);
    }
  });
  S.chatEl = h('div.st-chat');
  S.chatStatus = h('div.st-chat-status');
  const running = d.runs.find((r) => r.agentId === id);
  const removeFrom = async (w: TeamView) => {
    const copy = structuredClone(w);
    setMembers(copy, copy.members.filter((x) => x !== id));
    await saveWorkflow(copy);
    toast(`Removed ${a.name} from ${w.name}`);
    renderAgentPanel(id, wfId);
  };
  mount(
    S.panel,
    panelHead(avatar(a, true), h('div.grow', h('div.st-panel-title', a.name), h('div.hint', a.specialty || ''))),
    h(
      'div.st-panel-body',
      (() => {
        const now = nowText(id, wfId);
        return h(
          'div.st-agent-now',
          { class: now.st },
          now.st === 'working' ? h('span.dot.busy') : now.st === 'needs' ? h('span.dot.warn') : h('span.dot.on'),
          h('span.grow', now.st === 'working' ? now.text : now.st === 'needs' ? 'Waiting for your OK (see below)' : 'Ready'),
        );
      })(),
      modelSection(a),
      h(
        'div.row.mt',
        { style: { gap: '6px' } },
        h('button.btn.small', { onclick: () => openChat('agent', id) }, icon('message-square', 14), 'Chat'),
        h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${id}`) }, 'Full page'),
        a.engine !== 'openai' ? h('button.btn.ghost.small', { onclick: () => openTerminal(a) }, 'Terminal') : null,
        h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${id}/edit`) }, 'Edit'),
        h('button.btn.ghost.small', { title: 'Make a copy of this agent', onclick: () => cloneAgent(a) }, icon('copy', 13), 'Clone'),
        h('button.btn.ghost.small', { title: 'Keep it as a template for any project', onclick: () => presetAgent(a) }, icon('bookmark-plus', 13), 'Preset'),
      ),
      h('div.label.mt-lg', 'Skills'),
      h(
        'div.mt',
        skillPicker(
          a.skills || [],
          (v) => attempt(() => PUT(`/agents/${id}`, { skills: v })).then(() => refreshSoon(0)),
          {
            inherited: [
              ...(d.project?.skills || []).map((slug) => ({ slug, from: 'project' })),
              ...S.workflows.filter((w) => (w.members || []).includes(id)).flatMap((w) => (w.skills || []).map((slug) => ({ slug, from: w.name }))),
            ],
            empty: 'No skills yet.',
          },
        ),
      ),
      h('div.label.mt-lg', `Teams (${onBranches.length})`),
      h(
        'div.st-conns',
        onBranches.map((w) =>
          h(
            'div.st-conn.ok',
            h('span.st-dot', { style: { '--c': wfColor(w, S!.workflows.indexOf(w)) } }),
            h('span.grow', { style: { cursor: 'pointer' }, onclick: () => choose({ type: 'branch', id: w.id }) }, w.name, h('span.hint', w.lead === id ? ' · ★ lead' : ' · member')),
            h('button.btn.tiny.ghost', {
              title: `Open ${w.name}'s chat with @${a.name}`,
              onclick: () => openChat('team', w.id).mention?.(a.name),
            }, 'Chat'),
            w.lead !== id ? h('button.btn.tiny.ghost', { title: 'Make lead of this team', onclick: () => saveWorkflow({ ...structuredClone(w), lead: id }).then(() => renderAgentPanel(id, wfId)) }, '★') : null,
            h('button.btn.tiny.ghost', { title: `Take ${a.name} off this team`, onclick: () => removeFrom(w) }, 'Remove'),
          ),
        ),
        !onBranches.length ? h('p.hint', 'On the Bench: not in any team yet. Add it to one below, or drag it onto a team on the map.') : null,
      ),
      others.length
        ? h(
            'div.row.nowrap.mt',
            h('div.grow', dropdown(others.map((w) => ({ value: w.id, label: w.name })), addTo, (v) => (addTo = v))),
            h('button.btn.small', {
              onclick: async () => {
                const w = structuredClone(S!.workflows.find((x) => x.id === addTo));
                if (!w) return;
                setMembers(w, [...w.members, id]);
                await saveWorkflow(w);
                toast(`Added ${a.name} to ${w.name}`);
                renderAgentPanel(id, addTo);
              },
            }, 'Add to team'),
          )
        : null,
      h('div.label.mt-lg', 'Connections it can use'),
      connectionList(agentLinks(a)),
      a.engine === 'claude-code' && S.headbar?.connectors?.length
        ? h('div.st-conns', h('div.hint', 'Plus the connectors on your Claude account:'), h('div.row', { style: { gap: '4px' } }, S.headbar.connectors.map((c) => {
            const look = connectorLook(c.name);
            return h('span.st-badge', { style: { '--c': c.status === 'connected' ? look.color : '#555850' }, title: `${c.name}: ${c.status === 'connected' ? 'connected' : 'needs sign-in'}` }, logo(c.name, 11) || look.glyph);
          })))
        : null,
      d.approvals.filter((x) => x.agentId === id).map((x) => h('div.mt', approvalCard(x))),
    ),
  );
}

function drawMiniChat(): void {
  if (!S?.chatEl || !S.chat) return;
  const items = S.chat.items.filter((i) => i.type !== 'meta').slice(-14);
  mount(
    S.chatEl,
    items.length
      ? items.map((i) => {
          if (i.type === 'user') return h('div.st-msg.user', i.text);
          if (i.type === 'assistant') {
            const m = md(i.text.length > 2500 ? i.text.slice(0, 2500) + '…' : i.text);
            m.className = 'st-msg assistant';
            return m;
          }
          if (i.type === 'tool')
            return h('div.st-msg.tool', { class: i.isError ? 'err' : '' }, i.status === 'running' ? h('span.dot.busy') : h('span', i.isError ? '✕' : '✓'), ` ${i.name}`, i.images?.length ? h('div.st-imgs', i.images.slice(0, 4).map((src) => h('img', { src }))) : null);
          if (i.type === 'error') return h('div.st-msg.err', i.text);
          if (i.type === 'compaction') return h('div.st-msg.cmp', { title: 'The agent’s memory of the messages above was compacted. Open the full chat to see or edit it.' }, '— COMPACTED —');
          return null;
        })
      : h('p.empty', 'No messages yet.'),
  );
  S.chatEl.scrollTop = S.chatEl.scrollHeight;
}

async function sendMini(input: HTMLTextAreaElement): Promise<void> {
  const text = input.value.trim();
  if (!text || !S?.chat) return;
  const { agentId } = S.chat;
  input.value = '';
  let chatId = S.chat.id;
  if (!chatId) {
    const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
    if (!c) return;
    chatId = S.chat.id = c.id;
  }
  const r = await attempt(() => POST(`/agents/${agentId}/chats/${chatId}/messages`, { text }));
  if (!r) input.value = text;
}

// ---------- live events ----------
export function onEvent(ev: ServerEvent): void | Promise<void> {
  if (!S) return;
  const d = state.data;
  if (ev.type === 'workflows') return reloadWorkflows();
  // a program was opened or closed: light its tile and the desks that use it
  if (ev.type === 'programs') {
    GET<Program[]>('/programs')
      .then((p) => {
        if (!S || !p) return;
        S.progs = p;
        if (signature() !== S.signature) rebuild();
        drawHud();
        if (S.selected) renderPanel();
      })
      .catch(() => {});
    return;
  }
  if (isEvent(ev, 'team')) {
    const e = ev.event;
    const b = S.branches.get(ev.teamId);
    if (e.kind === 'state') {
      S.teamState[ev.teamId] = { working: e.working, queued: e.queued };
      shareTeams();
      updateStatuses();
    } else if (e.kind === 'message') {
      const m = e.message;
      S.teamLast[ev.teamId] = m;
      const nameOf = (id: string) => d?.agents.find((a) => a.id === id)?.name || 'Agent';
      if (b && m.from === 'user') pulseAlong(ev.teamId, 0, 1, 6);
      if (b && m.from !== 'user' && m.from !== 'system') {
        for (const id of m.mentions || []) pulseHandoff(ev.teamId, m.from, id);
        if (!m.mentions?.length) b.flash = Math.max(b.flash || 0, 0.5);
      }
      const tname = S.workflows.find((w) => w.id === ev.teamId)?.name || 'Team';
      if (m.from !== 'system') feedPush(`${tname} · ${m.from === 'user' ? 'You' : nameOf(m.from)}${m.mentions?.length && m.from !== 'user' ? ` → ${m.mentions.map(nameOf).join(', ')}` : ''}: ${String(m.text).slice(0, 60)}`, 'workflow');
      drawBranchCard(ev.teamId);
    }
    return;
  }
  if (ev.type === 'project') {
    closeChatsForProject();
    choose(null);
    S.shape = null;
    loadData().then(() => {
      if (!S) return;
      rebuild();
      drawHud();
      resetView();
    });
    return;
  }
  if (isEvent(ev, 'workflow-run') && ev.run) {
    const r = ev.run;
    const prev = S.active.get(r.workflowId);
    const prevIdx = prev ? prev.steps.findIndex((s) => s.status === 'running' || s.status === 'needs-you') : -1;
    const idx = r.steps.findIndex((s) => s.status === 'running' || s.status === 'needs-you');
    const wf = S.workflows.find((w) => w.id === r.workflowId);
    const b = S.branches.get(r.workflowId);
    if (r.status === 'running') {
      S.active.set(r.workflowId, r);
      if (b && idx !== prevIdx && idx >= 0) {
        // the step's own agent (pods seat the lead first, so the step number isn't the desk number)
        const stepAgent = r.steps[idx].agentId;
        if (stepAgent) pulseToDesk(r.workflowId, stepAgent);
        feedPush(`${wf?.name || 'Team'} → step ${idx + 1}: ${r.steps[idx].label}`, 'workflow');
        const node = stepAgent ? b.nodes.find((n) => n.agentId === stepAgent) : undefined;
        if (node) for (const l of node.links) pulseIntegration(l, node);
      }
    } else {
      S.active.delete(r.workflowId);
      if (b) pulseAlong(r.workflowId, 1, 0, 8);
      feedPush(`${wf?.name || 'Team'} ${r.status === 'done' ? 'finished ✓' : r.status}${r.error ? `: ${r.error}` : ''}`, r.status === 'failed' ? 'error' : 'workflow');
      GET<WorkflowRun[]>('/workflow-runs').then((runs) => S && ((S.wfRuns = runs), updateStatuses()));
    }
    updateStatuses();
    drawHud();
    if (S.selected?.type === 'branch' && S.selected.id === r.workflowId) renderPanel();
    return;
  }
  if (isEvent(ev, 'run')) {
    const a = d?.agents.find((x) => x.id === ev.agentId);
    const e = ev.event;
    const desks = S.desks.filter((x) => x.agent.id === ev.agentId);
    if (e.kind === 'start' && a) {
      for (const desk of desks) if (desk.wfId) pulseToDesk(desk.wfId, desk.agent.id);
      for (const desk of desks) desk.act = { kind: 'thinking', since: Date.now() };
      if (!/^(workflow|team)/.test(e.from || '')) feedPush(`${a.emoji || ''} ${a.name}: ${String(e.text || '').slice(0, 70)}`);
    } else if (e.kind === 'tool') {
      for (const desk of desks) {
        desk.activity = e.name;
        desk.act = { kind: 'tool', ...describeTool(e.name, e.args as ToolArgs | undefined), since: Date.now() };
        drawScreen(desk, S.clock.elapsedTime);
      }
      const intId = toolIntegration(e.name);
      if (intId) {
        const nodes = S.nodes.filter((n) => n.agentId === ev.agentId);
        if (nodes.length) nodes.forEach((n) => pulseIntegration(intId, n));
        else pulseIntegration(intId, null);
      }
      if (a) feedPush(`${a.name} → ${e.name}`);
    } else if (e.kind === 'text') {
      for (const desk of desks) if (desk.act?.kind !== 'tool') desk.act = { kind: 'writing', since: desk.act?.since || Date.now() };
    } else if (e.kind === 'tool_result') {
      for (const desk of desks) desk.act = { kind: 'thinking', since: Date.now() };
    } else if (e.kind === 'done' && a) feedPush(`${a.emoji || ''} ${a.name} finished (${e.seconds}s)`);
    else if (e.kind === 'error' && a) feedPush(`${a.name}: ${String(e.text).slice(0, 80)}`, 'error');

    if (S.chat && S.chat.agentId === ev.agentId && (!S.chat.id || S.chat.id === ev.chatId)) {
      S.chat.id ||= ev.chatId;
      const items = S.chat.items;
      if (e.kind === 'start') {
        const last = items[items.length - 1];
        if (!(last?.type === 'user' && last.text === e.text)) items.push({ type: 'user', text: e.text });
        S.chatStream = null;
        setChatStatus('Thinking…');
      } else if (e.kind === 'text') {
        if (S.chatStream == null || items[S.chatStream]?.type !== 'assistant') {
          items.push({ type: 'assistant', text: '' });
          S.chatStream = items.length - 1;
        }
        (items[S.chatStream] as Extract<ChatItem, { type: 'assistant' }>).text += e.text;
        setChatStatus('Writing…');
      } else if (e.kind === 'tool') {
        S.chatStream = null;
        items.push({ type: 'tool', id: e.id, name: e.name, status: 'running' });
        setChatStatus(`Using ${e.name}…`);
      } else if (e.kind === 'tool_result') {
        const it = [...items].reverse().find((x) => x.type === 'tool' && x.id === e.id);
        if (it) Object.assign(it, { status: 'done', isError: e.isError, images: e.images });
      } else if (e.kind === 'status') setChatStatus(e.text);
      else if (e.kind === 'done' || e.kind === 'error') {
        setChatStatus('');
        // Sync with the saved chat so nothing streamed before the panel opened is missing.
        const { agentId, id } = S.chat;
        if (id) GET<Chat>(`/agents/${agentId}/chats/${id}`).then((c) => {
          if (S?.chat?.id === id) {
            S.chat.items = c.items;
            drawMiniChat();
          }
        }).catch(() => {});
      }
      scheduleChat();
    }
  } else if (isEvent(ev, 'activity') && ev.entry && !['run', 'workflow'].includes(ev.entry.kind)) feedPush(ev.entry.text, ev.entry.kind);
  else if (ev.type === 'compacted' && S.chat?.id && S.chat.id === ev.chatId) {
    // show the COMPACTED mark where it went
    const { agentId, id } = S.chat;
    GET<Chat>(`/agents/${agentId}/chats/${id}`).then((c) => {
      if (S?.chat?.id === id) {
        S.chat.items = c.items;
        drawMiniChat();
      }
    }).catch(() => {});
  }
}

let chatFrame = false;
function scheduleChat(): void {
  if (chatFrame) return;
  chatFrame = true;
  requestAnimationFrame(() => {
    chatFrame = false;
    drawMiniChat();
  });
}

function setChatStatus(t: string): void {
  if (S?.chatStatus) mount(S.chatStatus, t ? [h('span.dot.busy'), ` ${t}`] : []);
}
