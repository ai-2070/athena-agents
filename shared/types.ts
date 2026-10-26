// Types shared by the server (server/) and the browser app (web/).
// The server stores these as JSON files; the browser gets them from the API.
import type { Effort } from './effort.ts';
export type { Effort } from './effort.ts';

export type EngineId = 'claude-code' | 'openai' | 'hermes' | 'codex';
export type Autonomy = 'ask' | 'auto' | 'full';
export type ProviderId = 'openrouter' | 'lmstudio' | 'ollama' | 'custom';
export type ClaudeAuth = 'login' | 'anthropic' | 'openrouter';

// ---------- agents ----------
export interface AgentSource {
  type: 'custom' | 'agency' | 'starter' | 'hermes' | 'claude' | 'brain' | 'preset' | string;
  slug?: string;
  division?: string;
  preset?: string;
  profile?: string;
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  specialty: string;
  description: string;
  systemPrompt: string;
  engine: EngineId;
  model: string;
  provider: ProviderId | string;
  claudeAuth: ClaudeAuth | string;
  hermesProfile: string;
  autonomy: Autonomy;
  toolGroups: string[];
  mcpServers: string[];
  knowledge: { folders: string[] };
  workspace: string;
  temperature: number | '';
  /** How hard the model thinks (see shared/effort.ts). '' or missing = the model's default. */
  effort?: Effort | '';
  alwaysAllow: string[];
  skills: string[];
  /** Rich answers: in your own chats it answers in OpenUI Lang, shown as live components (cards, tables, charts, forms). */
  richAnswers?: boolean;
  source: AgentSource;
  pinned: boolean;
  lastModel?: string;
  lastModelAt?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Set only while an agent works for a team: that team's skills. Never saved. */
  _teamSkills?: string[];
}

// ---------- teams (stored in the "workflows" collection) ----------
export interface TeamAccess {
  toolGroups: string[];
  mcpServers: string[];
}

export interface Schedule {
  type: 'none' | 'daily' | 'interval' | string;
  /** daily: 'HH:MM' */
  time?: string;
  /** interval: every N minutes */
  minutes?: number;
  /** daily: which weekdays (0 = Sunday); empty = every day */
  days?: number[];
  input?: string;
}

/** Old teams were step lists; teams now are group chats with members. Steps mirror the members. */
export interface TeamStep {
  id?: string;
  type: 'agent' | 'tool' | 'approval' | string;
  agentId?: string;
  prompt?: string;
  label?: string;
  tool?: string;
  [k: string]: unknown;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  color?: string;
  members: string[];
  lead: string | null;
  access?: TeamAccess;
  skills?: string[];
  /** Reference files the user gave the team (paths in the project's uploads/ folder). */
  files?: string[];
  steps: TeamStep[];
  schedule?: Schedule;
  enabled?: boolean;
  /** Where it sits on the Station map, and its spin. Null = next to the Brain. */
  pos?: { x: number; z: number } | null;
  rot?: number | null;
  angle?: number | null;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TeamState {
  working: string[];
  queued: string[];
  /** your /queue messages, posted one by one once nobody is working */
  held?: QueuedMessage[];
}

/** A message typed with /queue: it waits until the agent or team is done, then goes as usual. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: string[];
  /** (team chats) the message it answers */
  replyTo?: string | null;
  ts: number;
}

/** A team as GET /api/workflows returns it: with who is working and its latest message. */
export interface TeamListing extends Team {
  state?: TeamState;
  last?: TeamMessage | null;
}

export interface TeamMessage {
  id: string;
  ts: number;
  from: string; // 'user' | 'system' | agent id
  text: string;
  mentions: string[];
  replyTo?: string | null;
  handedTo?: string[];
  /** An agent's reply: where its turn is in the agent's own session for this team (its steps and tool
   *  calls are items from..to of that chat), so the team chat can show the work behind it. */
  turn?: { chatId: string; from: number; to: number };
  /** Files and folders attached to the message (paths in the project's uploads/ folder). */
  attachments?: string[];
  [k: string]: unknown;
}

// ---------- routines ----------
export type RoutineMentionKind = 'agent' | 'team' | 'skill';

/** Something a routine's text names with @Name. id is a skill's slug for skills. */
export interface RoutineMention {
  kind: RoutineMentionKind;
  id: string;
  name: string;
  /** Set on the way out when the agent, team or skill no longer exists. Never saved. */
  missing?: boolean;
}

/** Saved instructions you run by hand or on a schedule. The @mentioned agents and teams do them,
 *  with the @mentioned skills. */
export interface Routine {
  id: string;
  name: string;
  description?: string;
  text: string;
  mentions: RoutineMention[];
  schedule?: Schedule;
  enabled?: boolean;
  lastScheduledAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface RoutineRunTarget {
  kind: 'agent' | 'team';
  id: string;
  name: string;
  /** sent: posted in the team chat, where the team carries on */
  status: 'running' | 'done' | 'sent' | 'failed' | 'stopped';
  chatId?: string | null;
  output?: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  trigger: 'manual' | 'schedule' | string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  skills: string[];
  targets: RoutineRunTarget[];
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}

/** A routine as GET /api/routines returns it: with its latest run. */
export interface RoutineListing extends Routine {
  lastRun?: RoutineRun | null;
}

// ---------- projects ----------
export interface Project {
  id: string;
  name: string;
  description?: string;
  brainPath: string;
  repo: string;
  skills?: string[];
  createdAt: number;
  openedAt?: number;
  /** When its logo (.dashboard/logo.*) last changed; null = no logo. Added by the server when it sends projects. */
  logoAt?: number | null;
}

// ---------- chats ----------
export type ChatItem =
  | { type: 'user'; text: string; from?: string | null; attachments?: string[]; ts?: number }
  | { type: 'assistant'; text: string; ts?: number }
  | { type: 'tool'; id: string; name: string; args?: unknown; result?: string | null; status: 'running' | 'done' | 'error'; isError?: boolean; images?: string[]; ts?: number }
  | { type: 'error'; text: string; ts?: number }
  /** reset: "Clear memory" (the agent starts fresh after it) */
  | { type: 'meta'; text: string; ts?: number; reset?: boolean }
  | CompactionItem;

/** How a compaction was made. instant: the original words, cut to fit (no model call). summary: a model
 *  wrote a summary. engine: the engine compacted its own memory (Claude Code), so there is no text here. */
export type CompactionMode = 'instant' | 'summary' | 'engine';
/** auto: the chat got full. manual: you asked (button or /compact). overflow: the model said it was too long. */
export type CompactionTrigger = 'auto' | 'manual' | 'overflow';

/** The "--- COMPACTED ---" marker in a chat. From here on the agent remembers the items before it as text
 *  (the checkpoint), plus the items from upto on word for word. */
export interface CompactionItem {
  type: 'compaction';
  id: string;
  /** The compacted history the agent sees (you can edit it). Empty for mode "engine". */
  text: string;
  mode: CompactionMode;
  trigger: CompactionTrigger;
  /** Index of the first item kept word for word (the items before it are in text). */
  upto: number;
  /** Rough size of the agent's memory before and after, in tokens. */
  tokensBefore?: number;
  tokensAfter?: number;
  /** Set when you changed text by hand. */
  editedAt?: number;
  /** Why it is not what you asked for (e.g. the summary failed, so it is instant). */
  note?: string;
  ts?: number;
}

/** How full the agent's memory of a chat is, as the engine last said (or as estimated). */
export interface ChatContext {
  tokens: number;
  /** the model's context window, when the engine says it */
  window?: number;
  /** chat.items.length when this was measured: items after it are not counted yet */
  items: number;
  at: number;
  /** which engine, provider and model measured it ("engine|provider|model"): another one ignores it */
  by?: string;
}

export interface Chat {
  id: string;
  agentId: string;
  title: string;
  items: ChatItem[];
  llm: unknown[];
  sessionId: string | null;
  /** Set when this is the agent's session for a team chat. */
  teamId?: string | null;
  /** Set after a compaction: the next run starts a new engine session that gets the compacted history first. */
  reseed?: boolean;
  /** How full the agent's memory is (see ChatContext). Cleared by a compaction or Clear memory. */
  context?: ChatContext;
  /** Its last run had Rich answers' instructions (a chat of your own, not a handoff or a team's). */
  rich?: boolean;
  /** When the agent's MEMORY.md had last changed as of its last run here (see engines/index.ts). */
  memoryAt?: number;
  createdAt: number;
  updatedAt: number;
  _deleted?: boolean;
  /** Your /queue messages for when the current run is done (kept in memory; GET adds them, never saved). */
  queued?: QueuedMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  count: number;
  teamId?: string | null;
}

// ---------- runs and live events ----------
export type RunEvent =
  | { kind: 'start'; text: string; from?: string | null; attachments?: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args?: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; text?: string; isError?: boolean; images?: string[] }
  | { kind: 'status'; text: string }
  | { kind: 'model'; model: string }
  | { kind: 'done'; text: string; cost?: number; seconds?: number }
  /** the engine compacted its own memory (Claude Code): marked in the chat, never sent on as a run event */
  | { kind: 'compacted'; trigger?: string; tokensBefore?: number }
  | { kind: 'error'; text: string };

export interface ActiveRun {
  id: string;
  agentId: string;
  chatId: string;
  startedAt: number;
  agentName: string;
  parentRunId: string | null;
}

/** Everything the server pushes over the /ws socket. Extra fields depend on the type. */
export interface ServerEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

// ---------- approvals, outbox, activity ----------
export interface Approval {
  id: string;
  kind: string;
  title: string;
  detail: string;
  agentId: string | null;
  agentName: string;
  data: Record<string, unknown>;
  editable: unknown;
  createdAt: number;
  /** Why the Brain passed this on to you instead of allowing it (Settings > The Brain approves). */
  brainNote?: string;
}

/** Something a team finished that isn't an outgoing post: a written result, a file or a folder. */
export interface Artifact {
  id: string;
  title: string;
  kind: 'text' | 'file' | 'folder';
  /** file / folder: the full path, inside the project's folders */
  path?: string;
  /** text: the result itself (Markdown) */
  text?: string;
  note?: string;
  agentId?: string | null;
  agentName?: string;
  /** The team it was done for, named at the time (a renamed team keeps its old name here). */
  teamId?: string | null;
  teamName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface OutboxPost {
  id: string;
  platform: 'x' | 'x_dm' | 'reddit' | 'telegram' | 'discord' | string;
  accountId?: string | null;
  accountLabel?: string;
  parts: string[];
  /** Image files (full paths inside the project's folders) that go with the first part. X only. */
  images?: string[];
  status: 'pending' | 'posting' | 'posted' | 'failed' | 'rejected' | 'returned' | string;
  agentId?: string | null;
  /** The team the draft was written for (named at the time); where Send back to the team goes. */
  teamId?: string | null;
  teamName?: string;
  /** X: ids of the parts already posted (a thread can be finished later), and what it replies to */
  postIds?: string[];
  replyTo?: string | null;
  postedAt?: number;
  error?: string | null;
  reason?: string;
  agentName?: string;
  note?: string;
  url?: string;
  to?: string;
  reddit?: { kind: 'post' | 'comment'; subreddit?: string; title?: string; link?: string; parent?: string };
  createdAt?: number;
  updatedAt?: number;
  [k: string]: unknown;
}

export interface ActivityEntry {
  id: string;
  kind: string;
  text: string;
  ts: number;
  agentId?: string;
  chatId?: string;
  [k: string]: unknown;
}

// ---------- settings ----------
export interface BrainSetting {
  provider: 'claude' | 'openrouter' | 'hermes' | 'codex';
  model: string;
  /** How hard it thinks. '' or missing = the model's default. */
  effort?: Effort | '';
}

/** A model you starred in the model picker. provider: for API models (OpenRouter or a server on this PC). */
export interface FavoriteModel {
  engine: EngineId;
  model: string;
  provider?: string;
}

/** Settings > Chat memory: compacting long chats so the agent never runs out of room. */
export interface CompactionSetting {
  /** Compact a chat by itself when the agent's memory of it gets full. */
  auto: boolean;
  /** Instant compaction: keeps the original words (cut to fit) and needs no model call. Off: the Brain's model writes a summary. */
  instant: boolean;
  /** Compact when the memory reaches this share of the model's context window (10-95). */
  thresholdPercent: number;
  /** How many of the latest messages (yours and the agent's) stay in full, with their tool calls.
   *  The message being answered always does. The rest is compacted. */
  keepMessages: number;
  /** The context window in tokens, for every agent. 0: as the engine or model list says (else a safe default). */
  windowTokens: number;
}

export interface LookSetting {
  scale: number;
  accent: string;
  motion: 'full' | 'reduced';
}

export interface Settings {
  defaults: { engine: EngineId; claudeModel: string; openrouterModel: string; hermesProfile: string; autonomy: Autonomy };
  providers: { lmstudio: { baseUrl: string }; ollama: { baseUrl: string }; custom: { baseUrl: string; label: string } };
  comfyui: { url: string; workflowDirs: string[] };
  paths: Record<string, string>;
  allowedFolders: string[];
  x: { clientId: string };
  reddit: { clientId: string; username: string };
  brain: BrainSetting;
  /** The Brain answers agents' and teams' permission requests, and only asks you about the risky or unclear ones. */
  brainApproves: boolean;
  /** Skills the Brain itself follows (slugs). With "self-improvement" it also learns from finished work. */
  brainSkills: string[];
  /** The Brain may install skills from any GitHub link, not only from repos you named in the chat. */
  brainAnyGitHub: boolean;
  look: LookSetting;
  telegram: { chatId: string };
  maxToolSteps: number;
  costLimitUsdPerRun: number;
  compaction: CompactionSetting;
  /** Models starred in the model picker: they get their own tab at the front. */
  favoriteModels: FavoriteModel[];
  activeProject?: string;
}

export type SecretKey = 'openrouterKey' | 'anthropicKey' | 'customKey' | 'xClientSecret' | 'telegramBotToken' | 'discordWebhook' | 'redditClientSecret';
export type SecretStatus = Record<SecretKey, { set: boolean; hint?: string }>;

// ---------- engines ----------
export interface EngineStatus {
  'claude-code': { installed: boolean; path: string | null; loggedIn: boolean; version: string | null };
  openai: { openrouter: boolean; custom: boolean };
  hermes: { installed: boolean; path: string | null };
  codex: { installed: boolean; loggedIn: boolean; version: string | null; path?: string | null; how?: string };
}

export interface EngineInfo {
  id: EngineId;
  label: string;
  description?: string;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
}

// ---------- accounts ----------
export interface XAccount {
  id: string;
  username: string;
  name: string;
  autopost: boolean;
  connectedAt: number;
  avatar?: string;
}

export interface RedditAccount {
  id: string;
  username: string;
  autopost: boolean;
  connectedAt: number;
  icon?: string;
}

export interface Accounts {
  x: XAccount[];
  xAppConfigured: boolean;
  telegram: { configured: boolean };
  discord: { configured: boolean };
  reddit: RedditAccount[];
  redditAppConfigured: boolean;
}

export interface Terminal {
  id: string;
  title: string;
  agentId: string | null;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
  command: string;
}

/** GET /api/state: everything the browser needs to draw. */
export interface AppState {
  agents: Agent[];
  mcpServers: string[];
  project: Project;
  projectSaved: { at: number; error?: string; agents?: number; teams?: number } | null;
  projects: Project[];
  approvals: Approval[];
  outboxPending: number;
  runs: ActiveRun[];
  engines: EngineStatus;
  engineList: EngineInfo[];
  toolGroups: ToolGroup[];
  settings: Settings;
  secrets: SecretStatus;
  accounts: Accounts;
  terminals: Terminal[];
  port: number;
  home: string;
  dataDir: string;
}

// ---------- skills and presets ----------
export interface SkillFile {
  path: string;
  size: number;
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  body: string;
  source: 'library' | 'claude';
  files: SkillFile[];
  updatedAt: number;
  /** Where it was installed from (GitHub), if it was. */
  origin?: SkillOrigin;
}

/** A skill installed from GitHub: where from (<skill>/.source.json). */
export interface SkillOrigin {
  url: string;
  /** owner/repo */
  repo: string;
  ref: string;
  /** the skill's folder in the repo ('' = the repo itself) */
  path: string;
  installedAt: number;
}

/** POST /api/skills/install: what installing from a GitHub link did. */
export interface SkillInstallResult {
  installed: { slug: string; name: string; updated: boolean; files: number }[];
  /** skills found but not installed, and why */
  skipped: string[];
}

export interface SkillListing extends Omit<Skill, 'body'> {
  preview: string;
}

export interface ClaudeSkill {
  slug: string;
  name: string;
  description: string;
  files: number;
  inLibrary: boolean;
}

export interface PresetListing {
  id: string;
  kind: 'agent' | 'team';
  name: string;
  description: string;
  emoji: string | null;
  color: string | null;
  members: { name: string; emoji: string }[] | null;
  lead: string | null;
  skills: string[];
  savedAt: number;
}

// ---------- versions (skills, agents, teams) ----------
export type VersionKind = 'skill' | 'agent' | 'team' | 'memory';
/** Who replaced a version: you, the Brain, or an agent (its own MEMORY.md). */
export type VersionAuthor = 'you' | 'brain' | 'agent';
/** One kept version, as GET /api/versions/:kind/:id lists it. */
export interface VersionEntry {
  id: string;
  /** when it was replaced or deleted */
  at: number;
  /** who replaced it */
  by: VersionAuthor;
  deleted?: boolean;
  note?: string;
  /** what the next version (or the current one) changed in it */
  changes: string[];
}
/** GET /api/versions/:kind/:id */
export interface VersionHistory {
  kind: VersionKind;
  id: string;
  name: string;
  /** the current one as text, or null when it's deleted */
  current: string | null;
  versions: VersionEntry[];
}
/** GET /api/versions/:kind/:id/:vid: one version as text. */
export interface VersionDetail extends VersionEntry {
  name: string;
  text: string;
}
/** GET /api/versions/:kind: what was deleted and can come back. */
export interface DeletedItem {
  kind: VersionKind;
  id: string;
  name: string;
  at: number;
  by: VersionAuthor;
}

// ---------- MEMORY.md ----------
/** GET /api/memory/:owner: an agent's MEMORY.md (owner: its id), or the Brain's (owner "brain"). */
export interface MemoryInfo {
  owner: string;
  /** whose it is: the agent's name, or "The Brain" */
  name: string;
  text: string;
  /** when it last changed (0: never written) */
  updatedAt: number;
  /** the most it may hold, in characters */
  max: number;
}

// ---------- the Brain ----------
export type BrainDone = { kind: 'team' | 'hired' | 'file' | 'routine' | 'skill' | 'memory' | 'error' | 'note'; text: string; teamId?: string; agentId?: string; routineId?: string; skillId?: string; file?: string; /** whose MEMORY.md it changed (an agent id, or "brain") */ memory?: string };
export interface BrainDelegate {
  kind: 'agent' | 'branch';
  id: string;
  name: string;
  message: string;
  /** The files you attached for the Brain, handed on with the work. */
  attachments?: string[];
}

/** One file or folder saved by POST /api/uploads/:batch. top: the file itself, or the dropped folder it is in. */
export interface UploadedFile {
  path: string;
  top: string;
  kind: 'file' | 'folder';
  name: string;
  size: number;
}
export interface BrainAnswer {
  answer: string;
  done: BrainDone[];
  delegate: BrainDelegate | null;
  model: { provider: string; model: string; fallback?: boolean };
  project: string;
}

// ---------- usage meters in the header ----------
export interface UsageMeter {
  label: string;
  percent?: number | null;
  resetsAt?: number | null;
  text?: string | null;
}
export interface ProviderUsage {
  id: 'claude' | 'openrouter' | 'codex';
  name: string;
  meters: UsageMeter[];
}
