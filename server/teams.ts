// Teams are group chats of agents. You write in the team chat; who answers: whoever you name, else the
// author of the message you replied to, else the only member with a service it needs (services.ts),
// else the lead, else the best fit. Agents hand work to each other by @mentioning a teammate, and
// everyone sees one shared thread.
// Each agent keeps its own memory of the team (its own chat session), and gets the new messages each turn.
// The Brain writes here too: it hands the team work, answers when someone writes @Brain, and looks at
// the thread when the team goes quiet (see irc.ts).
// Teams talk to each other like IRC channels: a message that names #Other Team goes to that team's chat
// too, and once that team is done, its last reply comes back here to whoever asked.
import { BUILD_ORDER, DIORAMA } from './voxel/diorama.ts';
import {
  workflows as teamStore,
  agents,
  chats,
  emit,
  log,
  activeProject,
  openProject,
  getSettings,
  withProject,
  listProjects,
} from './store.ts';
import { readJSON, writeJSON, uid, dataPath, settledWithin } from './util.ts';
import { deleteThread, filePast, listThreads, newThreadId, pastHolds, reopenThread, startThread } from './pastchats.ts';
import type { ThreadMeta, ThreadPlace } from './pastchats.ts';
import {
  askAgent,
  hasBackgroundWork,
  joinChatTurn,
  missedMessages,
  nativeRunPromise,
  runInfo,
  stopChat,
  stopChildren,
  forgetChat,
  isStopping,
  RunStopped,
} from './engines/index.ts';
import { readRun as readEveRun } from './eve/state.ts';
import { readExecution } from './execution.ts';
import { activeTeamAssignment, readRelayWork, readTeamWork, saveRelayWork, saveTeamWork } from './teamwork.ts';
import { isStepList, teamSteps, parseTeamRefs, teamFrom, fromTeam } from '../shared/teams.ts';
import { attachmentNames, cleanAttachments } from './uploads.ts';
import { soleHolder, servicesOf } from './services.ts';
import { teamMessage } from './teamcontext.ts';
import { clearWork, openBrief, stopTeamWork } from './briefs.ts';
import type {
  Agent,
  LoopInfo,
  QueuedMessage,
  SavedTeamAssignment,
  SavedTeamInput,
  SavedTeamRelay,
  Team,
  TeamMessage,
  TeamRef,
  TeamRelay,
  TeamState,
  ThreadSummary,
} from '../shared/types.ts';
import type { LoopRequest } from '../shared/commands.ts';
import { queuedEdit, reorderQueued } from '../shared/queue.ts';
import { privateTeamDefinition, privateTeamRecord, privateTeams } from './private-conversations.ts';

// No limit on turns, so long work keeps going. What pauses a team is chatter: this many turns in a row
// where agents only talk (no tool used, a short reply), like two agents thanking each other forever.
export const MAX_CHATTER = 8;
const CHATTER_CHARS = 600; // a reply this long is work in itself (a draft, a plan), even without tools
const MAX_BRAIN_REPLIES = 4; // times the Brain answers @Brain per message you send
const MAX_RELAYS = 4; // times a team asks other teams per message you send
const MAX_RELAY_DEPTH = 3; // a team asking a team asking a team, at most
const ANSWER_CHARS = 8000; // of a team's answer, passed back to the team that asked
/** Who the Brain is in a thread (TeamMessage.from, and in TeamState.working while it answers). */
export const BRAIN = 'brain';

/** The team chat file: the shared thread, each agent's own chat session, and how far each agent has read.
 *  id and createdAt: which conversation it is, in the team's list of chats (pastchats.ts). */
interface TeamChat extends ThreadMeta {
  messages: TeamMessage[];
  sessions: Record<string, string>; // agentId -> chatId
  seen: Record<string, number>; // agentId -> messages.length when it last read
  filesSent?: Record<string, string[]>; // agentId -> the team files it has been given
}

/** A message before post() gives it an id and a time. */
interface NewMessage {
  sender?: string;
  id?: string;
  from: string;
  text: string;
  mentions?: string[];
  replyTo?: string | null;
  attachments?: string[];
  turn?: TeamMessage['turn'];
  relay?: TeamRelay;
}

type QueueItem = SavedTeamAssignment;

interface Runtime {
  queue: QueueItem[];
  running: Set<string>;
  episode: { turns: number; chatter?: number; brain?: number; relays?: number };
  stopped?: boolean;
  epoch: number; // bumped by stop and clear: turns started before then are dropped
  /** your /queue messages, posted one by one once nobody is working; heldIn: the project they were typed in */
  held: QueuedMessage[];
  heldIn?: string;
  route?: RouteFn | null;
  /** a held message is being posted */
  releasing?: boolean;
  /** @Brain messages waiting while the Brain answers another one (epoch: the thread they were written in) */
  brainQueue?: { msg: TeamMessage; epoch: number }[];
  /** the turns going now, by agent; and the ones cut off by Stop or the turn limit (what /resume picks up) */
  current?: Map<string, QueueItem>;
  interrupted?: QueueItem[];
  /** your /loop in this team */
  loop?: TeamLoop | null;
  /** each running turn, done once it has ended (a steer waits for the ones it stopped) */
  ends?: Map<string, Promise<void>>;
  /** a message sent while the team works is stopping the turns going now: nothing new starts meanwhile */
  steering?: boolean;
  /** those messages, one after the other (a second waits for the first to be posted) */
  steers?: Promise<unknown>;
  pending?: SavedTeamInput[];
  assigned?: Set<string>;
  brainCurrent?: TeamMessage;
  brainInterrupted?: TeamMessage[];
  recovered?: boolean;
}

interface TeamLoop extends LoopInfo {
  /** the project it was started in */
  project: string;
  attachments: string[];
  route: RouteFn | null;
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** one of its messages went and the team hasn't gone quiet since */
  posted: boolean;
}

/** Picks the member who should answer when nobody is named and there is no lead (brain.pickMember). */
export type RouteFn = (text: string, members: (Agent | null)[]) => Promise<string | null | undefined>;

/** What the Brain does in team chats (irc.ts sets these): answer a message that mentions @Brain
 *  (the reply text, posted here as the Brain), look at a team that went quiet, and pick who in a team
 *  answers a question from another team when nobody there is named. */
export interface BrainHandlers {
  reply(team: Team, msg: TeamMessage): Promise<string | null>;
  idle(teamId: string, opts: { stopped: boolean }): void;
  route?: RouteFn;
  assigned?(team: Team, msg: TeamMessage): void;
}
let brainHandlers: BrainHandlers | null = null;
export function setBrainHandlers(h: BrainHandlers | null): void {
  brainHandlers = h;
}

export const mentionsBrain = (text: unknown): boolean => /(^|[^\w@])@brain\b/i.test(String(text || ''));

// ---------- team records ----------
// Older teams were step lists: their agents become the members.
export function normalize<T extends Team | null | undefined>(team: T): T {
  if (!team) return team;
  if (!Array.isArray(team.members)) {
    team.members = [
      ...new Set((team.steps || []).filter((s) => s.type === 'agent' && s.agentId).map((s) => s.agentId as string)),
    ];
  }
  team.members = team.members.filter((id) => agents.get(id));
  if (team.lead && !team.members.includes(team.lead)) team.lead = null;
  return team;
}

export function getTeam(id: string | null | undefined): Team | null {
  return normalize(teamStore.get(id) || (id ? privateTeamDefinition(id) : null));
}

export function listTeams(): Team[] {
  return teamStore.list().map(normalize);
}

export { isStepList, teamSteps };

// ---------- the shared thread ----------
// pid: the project the chat belongs to (the active one unless a turn outlived a project switch)
function chatFile(teamId: string, pid = activeProject().id): string {
  if (!teamId || /[\\/]/.test(teamId)) throw new Error('No such team.');
  return dataPath('projects', pid, 'teamchats', `${teamId}.json`);
}
function loadChat(teamId: string, pid?: string): TeamChat {
  return readJSON<TeamChat>(chatFile(teamId, pid), { messages: [], sessions: {}, seen: {} });
}
function saveChat(teamId: string, c: TeamChat, pid?: string) {
  // (a conversation gets its id once something is said in it)
  if (!c.id && c.messages.length) Object.assign(c, { id: newThreadId(), createdAt: c.createdAt || c.messages[0].ts });
  writeJSON(chatFile(teamId, pid), c);
}

/** Full saved transcript. Callers must check team membership before exposing it to an agent. */
export function teamMessages(teamId: string): TeamMessage[] {
  return loadChat(teamId).messages;
}

/** The open conversation's id (none until something is said in it) and its full transcript. */
export function currentTeamThread(teamId: string): { id?: string; createdAt?: number; messages: TeamMessage[] } {
  const c = loadChat(teamId);
  return { id: c.id, createdAt: c.createdAt, messages: c.messages };
}

// ---------- who is working ----------
// Kept per project: a copied project has the same team ids, but its teams are other teams.
const rt = new Map<string, Runtime>(); // `<project id>/<team id>` -> { queue: [{agentId, msgIds}], running: Set, episode: {turns}, stopped }
function runtime(teamId: string, pid = activeProject().id): Runtime {
  const key = `${pid}/${teamId}`;
  if (!rt.has(key)) {
    const saved = readTeamWork(pid, teamId);
    const all = saved
      ? [...saved.current, ...saved.queue, ...saved.interrupted].filter(
          (item) => !item.steered || !saved.pending.some((input) => input.to.includes(item.agentId)),
        )
      : [];
    const interrupted = all.filter(
      (item, i) =>
        all.findIndex(
          (q) =>
            q.agentId === item.agentId &&
            JSON.stringify(q.msgIds) === JSON.stringify(item.msgIds) &&
            q.delivery?.runId === item.delivery?.runId,
        ) === i,
    );
    const owned = new Set(interrupted.flatMap((q) => q.msgIds));
    for (const msg of saved?.brain || []) owned.add(msg.id);
    const r: Runtime = {
      queue: [],
      running: new Set(),
      episode: saved?.episode || { turns: 0 },
      epoch: saved?.epoch || 0,
      held: saved?.held.filter((q) => !owned.has(q.id) && !saved.pending.some((p) => p.id === q.id)) || [],
      heldIn: pid,
      interrupted,
      pending: saved?.pending.filter((q) => !owned.has(q.id)) || [],
      assigned: new Set(saved?.assigned),
      brainInterrupted: saved?.brain || [],
      stopped: saved?.stopped,
      recovered: !!saved && !!(interrupted.length || saved.held.length || saved.pending.length || saved.brain.length),
    };
    if (relays.some((x) => x.pid === pid && (x.from === teamId || x.to === teamId))) r.recovered = true;
    if (r.recovered) r.stopped = true;
    rt.set(key, r);
  }
  return rt.get(key)!;
}

function saveRuntime(teamId: string, pid = activeProject().id): void {
  const r = runtime(teamId, pid);
  saveTeamWork({
    projectId: pid,
    teamId,
    queue: r.queue,
    current: [...(r.current?.values() || [])],
    interrupted: r.interrupted || [],
    held: r.held,
    pending: r.pending || [],
    assigned: [...(r.assigned || [])],
    brain: [
      ...(r.brainCurrent ? [r.brainCurrent] : []),
      ...(r.brainQueue || []).map((q) => q.msg),
      ...(r.brainInterrupted || []),
    ],
    episode: r.episode,
    stopped: !!r.stopped,
    epoch: r.epoch,
  });
}

/** Load private work before automatic completion checks can submit another assignment. */
export function recoverTeamWork(): void {
  const relayWork = readRelayWork();
  relays.splice(0, relays.length, ...relayWork.active);
  closedRelays.clear();
  for (const key of relayWork.closed) closedRelays.add(key);
  for (const project of listProjects())
    withProject(project, () => {
      for (const team of [...listTeams(), ...privateTeams().map(normalize)]) {
        const r = runtime(team.id);
        if (!r.recovered) continue;
        const sessions = loadChat(team.id).sessions;
        const joined: { item: QueueItem; promise: Promise<string> }[] = [];
        for (const receipt of readExecution().runs) {
          const item = activeTeamAssignment(receipt, team.id);
          const promise = item && nativeRunPromise(receipt.id);
          const live = item && runInfo(receipt.id);
          if (
            !item ||
            !promise ||
            !live ||
            live.projectId !== project.id ||
            sessions[item.agentId] !== item.delivery?.chatId ||
            r.running.has(item.agentId)
          )
            continue;
          // Use the runtime's saved object, so Stop and shutdown preserve this same delivery.
          const original = r.interrupted?.find((q) => q.delivery?.runId === receipt.id);
          if (!original) continue;
          r.interrupted = r.interrupted?.filter((q) => q !== original);
          r.running.add(item.agentId);
          (r.current ||= new Map()).set(item.agentId, original);
          joined.push({ item: original, promise });
        }
        if (joined.length) r.stopped = false;
        r.recovered = !!(
          r.interrupted?.length ||
          r.held.length ||
          r.pending?.length ||
          r.brainInterrupted?.length ||
          (!joined.length && r.recovered)
        );
        if (r.recovered) {
          if (!r.running.size) stopTeamWork(team.id);
          // A fixed id makes recovery itself safe to interrupt and repeat.
          post(team, {
            id: `restart-${r.epoch}`,
            from: 'system',
            text: 'The dashboard restarted. Saved turns continue where possible; other assignments and queued messages are paused. Use /resume to continue paused work.',
          });
        }
        saveRuntime(team.id);
        for (const { item, promise } of joined) followTurn(team, item, promise);
      }
    });
}
/** What a team's turns run under (Stop stops this project's ones only). */
const teamRunId = (teamId: string) => `team:${activeProject().id}/${teamId}`;
/** fn, and everything it awaits or starts, in the project it started in (not one opened meanwhile). */
const here = <T>(fn: () => T): T => withProject(activeProject(), fn);

export function teamState(teamId: string): TeamState {
  const r = runtime(teamId);
  return {
    working: [...r.running],
    queued: [...new Set(r.queue.map((q) => q.agentId))],
    held: [...r.held],
    loop: loopInfo(r.loop),
    resumable: !!(r.interrupted?.length || r.pending?.length || r.brainInterrupted?.length || r.recovered),
  };
}

/** Includes outstanding questions to other teams, not just local turns. */
export function isTeamBusy(teamId: string): boolean {
  const r = runtime(teamId);
  return !!(
    r.running.size ||
    r.queue.length ||
    r.held.length ||
    r.pending?.length ||
    r.steering ||
    r.releasing ||
    r.brainQueue?.length ||
    Object.values(loadChat(teamId).sessions).some((id) => hasBackgroundWork(id)) ||
    relays.some((x) => x.pid === activeProject().id && x.from === teamId)
  );
}

export function getThread(
  teamId: string,
  limit = 200,
): TeamState & { messages: TeamMessage[]; sessions: Record<string, string> } {
  const c = loadChat(teamId);
  // (each agent's own session for this team: where a working agent's turn streams from)
  return { messages: c.messages.slice(-limit), ...teamState(teamId), sessions: { ...c.sessions } };
}

function post(team: Team, msg: NewMessage): TeamMessage {
  const c = loadChat(team.id);
  const existing = msg.id && c.messages.find((m) => m.id === msg.id);
  if (existing) {
    if (
      existing.from !== msg.from ||
      existing.sender !== msg.sender ||
      existing.text !== msg.text ||
      (existing.replyTo || null) !== (msg.replyTo || null) ||
      JSON.stringify(existing.attachments || []) !== JSON.stringify(msg.attachments || [])
    )
      throw new Error('A saved team message cannot change.');
    return existing;
  }
  const full: TeamMessage = { id: uid('m'), ts: Date.now(), mentions: [], ...msg };
  c.messages.push(full);
  saveChat(team.id, c);
  emit('team', { teamId: team.id, event: { kind: 'message', message: full } });
  return full;
}

const state = (team: Team) => {
  saveRuntime(team.id);
  emit('team', { teamId: team.id, event: { kind: 'state', ...teamState(team.id) } });
};

// @Name (exact member names, longest first), plus @everyone / @all / @team.
export function parseMentions(team: Team, text: unknown, exclude: string | null = null): string[] {
  const t = String(text || '');
  const found = new Set<string>();
  if (/(^|\s)@(everyone|all|team)\b/i.test(t)) team.members.forEach((id) => found.add(id));
  const named = team.members
    .map((id) => agents.get(id))
    .filter((a): a is Agent => Boolean(a))
    .sort((a, b) => b.name.length - a.name.length);
  // longest names first, and each match is taken out, so "@Trend Scout" doesn't also count as "@Trend"
  let rest = t;
  for (const a of named) {
    const esc = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\w@])@${esc}(?![\\w])`, 'gi');
    if (re.test(rest)) {
      found.add(a.id);
      rest = rest.replace(re, '$1');
    }
  }
  if (exclude) found.delete(exclude);
  return [...found];
}

// ---------- you (or the Brain) write in the team chat ----------
interface PostOptions {
  sender?: string;
  /** Stable identity for a saved input. */
  messageId?: string;
  /** Internal goals and loops already have their own owner. */
  track?: boolean;
  replyTo?: string | null;
  route?: RouteFn | null;
  /** given to every member for the work this message starts (a routine's skills) */
  skills?: string[];
  attachments?: string[];
  /** who takes it when it names nobody and replies to nobody (the agents a steer stopped) */
  to?: string[];
  /** members who took it into the turn they are working on (a steer): with nobody in to, nobody else starts on it */
  joined?: string[];
  /** stops it before anyone starts on it (a routine that was stopped) */
  signal?: AbortSignal;
}

export function postUserMessage(
  teamId: string,
  text: string | null | undefined,
  opts: PostOptions = {},
): Promise<TeamMessage> {
  return postAndRoute(teamId, 'user', text, opts);
}

/** The Brain hands the team work (or follows up on it), as itself. */
export function postBrainMessage(
  teamId: string,
  text: string | null | undefined,
  opts: PostOptions = {},
): Promise<TeamMessage> {
  return postAndRoute(teamId, BRAIN, text, opts);
}

// from: you, the Brain, or another team (`team:<id>`, with relay saying who there asked)
function postAndRoute(
  teamId: string,
  from: string,
  text: string | null | undefined,
  opts: PostOptions & { relay?: TeamRelay },
): Promise<TeamMessage> {
  // (picking who answers can take a while: it goes on in this project even if you open another)
  return here(() => routeMessage(teamId, from, text, opts));
}

async function routeMessage(
  teamId: string,
  from: string,
  text: string | null | undefined,
  {
    replyTo = null,
    route = null,
    skills = [],
    attachments = [],
    relay,
    to = [],
    joined = [],
    signal,
    track = true,
    sender,
    messageId = uid('m'),
  }: PostOptions & { relay?: TeamRelay },
): Promise<TeamMessage> {
  if (signal?.aborted) throw new RunStopped();
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  text = String(text || '').trim();
  if (!text && !attachments.length) throw new Error('Write something first.');
  const r = runtime(team.id);
  const input: SavedTeamInput = {
    id: messageId,
    from,
    ...(sender ? { sender } : {}),
    text,
    replyTo,
    attachments,
    skills,
    to,
    track,
    ...(relay ? { relay } : {}),
  };
  if (!r.pending?.some((q) => q.id === messageId)) (r.pending ||= []).push(input);
  saveRuntime(team.id);
  const mentions = parseMentions(team, text);
  const wasPosted = loadChat(team.id).messages.some((m) => m.id === messageId);
  const msg = post(team, {
    id: messageId,
    from,
    ...(sender ? { sender } : {}),
    text,
    mentions,
    replyTo,
    ...(attachments.length ? { attachments } : {}),
    ...(relay ? { relay } : {}),
  });
  if (!wasPosted && track && ((from === 'user' && !mentionsBrain(text)) || fromTeam(from)))
    brainHandlers?.assigned?.(team, msg);
  r.episode = { turns: 0 }; // a new message from you gives the team a fresh budget
  r.stopped = false;
  r.interrupted = undefined; // (new work: what was cut off before is not picked up again)
  r.recovered = false;
  // you asked the Brain: it answers in the thread, and nobody else starts unless you named them
  const askBrain = from === 'user' && mentionsBrain(text);
  if (askBrain) void brainTurn(team, msg);
  // you named other teams (#Team Name): it goes to them, and here only to whoever you named
  const named = from === 'user' ? teamsNamed(team, text) : [];
  const asked = named.length ? askTeams(team, msg, named, from) : [];
  let targets = mentions;
  let assignedTeam = team;
  let why = '';
  if (!targets.length && (askBrain || asked.length || named.length)) {
    r.pending = r.pending?.filter((q) => q.id !== messageId);
    state(team);
    log(
      'team',
      `You → ${askBrain ? 'the Brain' : asked.map((id) => `#${getTeam(id)?.name}`).join(', ') || 'other teams'} in ${team.name}: ${text.slice(0, 100)}`,
    );
    return msg;
  }
  if (!targets.length && replyTo) {
    const parent = loadChat(team.id).messages.find((m) => m.id === replyTo);
    if (parent && team.members.includes(parent.from)) targets = [parent.from];
  }
  if (!targets.length) targets = to.filter((id) => team.members.includes(id));
  if (!targets.length && joined.length) {
    r.pending = r.pending?.filter((q) => q.id !== messageId);
    state(team);
    log(
      'team',
      `You → ${team.name} (taken into the work going on): ${(text || attachmentNames(attachments)).slice(0, 100)}`,
    );
    return msg;
  }
  if (!targets.length && text) {
    // it needs a service only one member has (GitHub, Blender, posting on X…): that member
    const sole = soleHolder(
      text,
      team.members.map((id) => agents.get(id)).filter((a): a is Agent => Boolean(a)),
    );
    if (sole) {
      targets = [sole.id];
      why = `the only one with ${sole.service}`;
    }
  }
  if (!targets.length && team.lead) {
    targets = [team.lead];
    why = 'the lead';
  }
  if (!targets.length) {
    // files only: route on their names
    const epoch = r.epoch;
    const pick = route
      ? await route(
          text || `(attached: ${attachmentNames(attachments)})`,
          team.members.map((id) => agents.get(id)),
        ).catch(() => null)
      : null;
    // stopped while it picked: nobody starts on it
    if (signal?.aborted) {
      r.pending = r.pending?.filter((q) => q.id !== messageId);
      state(team);
      post(team, { from: 'system', text: 'Stopped before anyone started on it.' });
      throw new RunStopped();
    }
    if (r.epoch !== epoch || r.stopped) return msg;
    // The roster may have changed while the router was choosing.
    const current = getTeam(team.id);
    if (!current?.members.length) {
      r.pending = r.pending?.filter((q) => q.id !== messageId);
      state(team);
      return msg;
    }
    assignedTeam = current;
    if (pick && current.members.includes(pick)) {
      targets = [pick];
      why = 'best fit';
    } else {
      const free = current.members.find((id) => !r.running.has(id));
      const id = free || current.members[0];
      targets = [id];
      why = free ? 'first member free' : 'everyone busy';
      const name = agents.get(id)?.name || 'someone';
      post(team, {
        from: 'system',
        text: free
          ? `No routing match: asked @${name}, the first member free.`
          : `No routing match: queued this for @${name}; everyone is busy.`,
      });
    }
  }
  r.pending = r.pending?.filter((q) => q.id !== messageId);
  enqueueMany(assignedTeam, targets, msg.id, true, false, skills);
  if (why) emit('team', { teamId: team.id, event: { kind: 'routed', to: targets, why } });
  log(
    'team',
    `${relay ? `#${relay.teamName}` : from === BRAIN ? 'The Brain' : 'You'} → ${team.name}: ${(text || attachmentNames(attachments)).slice(0, 100)}`,
  );
  return msg;
}

// ---------- #Team: asking another team ----------
// A question to another team is posted in its chat (from `team:<asker>`) and routed there like a message
// from you. When that team goes quiet, its last reply goes back to the asking team, to whoever asked.
const relays: SavedTeamRelay[] = [];
const closedRelays = new Set<string>();
const relayKey = (pid: string, from: string, to: string, messageId: string) =>
  JSON.stringify([pid, from, to, messageId]);
const saveRelays = () => saveRelayWork({ active: relays, closed: [...closedRelays] });
function closeRelay(relay: SavedTeamRelay) {
  if (relays.includes(relay)) relays.splice(relays.indexOf(relay), 1);
  for (const input of relay.deliveries) closedRelays.add(relayKey(relay.pid, relay.from, relay.to, input.messageId));
  saveRelays();
  for (const teamId of [relay.from, relay.to]) {
    const r = rt.get(`${relay.pid}/${teamId}`);
    if (
      r?.recovered &&
      !r.interrupted?.length &&
      !r.held.length &&
      !r.pending?.length &&
      !r.brainInterrupted?.length &&
      !relays.some((x) => x.pid === relay.pid && (x.from === teamId || x.to === teamId))
    ) {
      r.recovered = false;
      saveRuntime(teamId, relay.pid);
    }
  }
}

function resumeRelays(team: Team): void {
  const pid = activeProject().id;
  for (const relay of relays.filter((x) => x.pid === pid && x.to === team.id)) {
    const source = getTeam(relay.from);
    if (!source) {
      closeRelay(relay);
      continue;
    }
    for (const delivery of relay.deliveries) {
      const posted = loadChat(team.id).messages.find((m) => m.id === delivery.id);
      if (posted) {
        relay.postedId ||= posted.id;
        saveRelays();
        continue;
      }
      const msg = loadChat(source.id).messages.find((m) => m.id === delivery.messageId);
      if (!msg) {
        closeRelay(relay);
        break;
      }
      void postAndRoute(team.id, teamFrom(source.id), msg.text, {
        messageId: delivery.id,
        attachments: msg.attachments || [],
        route: brainHandlers?.route,
        relay: { teamId: source.id, teamName: source.name, by: relay.by, byName: nameOf(relay.by) },
      })
        .then((out) => {
          if (!relays.includes(relay)) return;
          relay.postedId ||= out.id;
          saveRelays();
          if (idle(runtime(team.id))) settled(team.id);
        })
        .catch((e: unknown) => {
          runtime(team.id).stopped = true;
          state(team);
          log('error', `${team.name}: a saved team request couldn't be sent: ${errText(e)}`);
        });
    }
  }
  for (const relay of relays.filter((x) => x.pid === pid && x.from === team.id)) {
    const target = getTeam(relay.to);
    if (target && runtime(target.id).recovered)
      post(team, {
        id: `waiting-${relay.id}`,
        from: 'system',
        text: `#${target.name} has saved work paused after the restart. Check its results and use /resume there to continue.`,
      });
  }
}

const askable = (t: Team) => t.members.length > 0 && !isStepList(t);
/** The other teams this one can ask (#Team Name), for its chat. */
export function otherTeams(teamId: string): TeamRef[] {
  if (privateTeamRecord(teamId)) return [];
  return listTeams()
    .filter((t) => t.id !== teamId && askable(t))
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
      ...(t.color ? { color: t.color } : {}),
      ...(t.mark ? { mark: t.mark } : {}),
    }));
}
const teamsNamed = (team: Team, text: unknown) =>
  privateTeamRecord(team.id) ? [] : parseTeamRefs(text, listTeams().filter(askable), team.id);
const nameOf = (id: string) =>
  id === 'user' ? 'the user' : id === BRAIN ? 'the Brain' : agents.get(id)?.name || 'someone';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ask the teams a message names. by: who wrote it. Returns the teams it went to. */
function askTeams(
  team: Team,
  msg: TeamMessage,
  ids: string[],
  by: string,
  { returning = false, skills = [] }: { returning?: boolean; skills?: string[] } = {},
): string[] {
  const r = runtime(team.id);
  const pid = activeProject().id;
  // how deep this team's work already is in questions between teams
  const depth = 1 + Math.max(0, ...relays.filter((x) => x.pid === pid && x.to === team.id).map((x) => x.depth));
  const sent: string[] = [];
  const refused: string[] = [];
  const why: string[] = [];
  for (const id of ids) {
    const to = getTeam(id);
    if (!to) continue;
    if (closedRelays.has(relayKey(pid, team.id, to.id, msg.id))) {
      sent.push(to.id);
      continue;
    }
    // they asked this team: naming them is the answer, and that goes back by itself once this team is done
    if (by !== 'user' && relays.some((x) => x.pid === pid && x.from === to.id && x.to === team.id)) continue;
    // they wait (through other teams) on this one: asking them would leave both waiting for good
    if (waitsOn(pid, to.id, team.id)) {
      why.push(`Not sent to #${to.name}: it is waiting on this team's answer. Answer here instead.`);
      continue;
    }
    if (depth > MAX_RELAY_DEPTH || (r.episode.relays || 0) >= MAX_RELAYS) {
      refused.push(`#${to.name}`);
      continue;
    }
    r.episode.relays = (r.episode.relays || 0) + 1;
    sent.push(to.id);
    // (kept from now on, so this team doesn't count as done while the question is on its way;
    // a second question while the first is open joins it: one answer comes back)
    let x = relays.find((y) => y.pid === pid && y.from === team.id && y.to === to.id);
    const joins = !!x;
    if (!x)
      relays.push(
        (x = {
          id: uid('relay'),
          from: team.id,
          to: to.id,
          by,
          askId: msg.id,
          postedId: '',
          pid,
          depth,
          returning,
          skills: [...skills],
          deliveries: [],
        }),
      );
    if (x.deliveries.some((d) => d.messageId === msg.id)) continue;
    const delivery = { id: uid('m'), messageId: msg.id };
    x.deliveries.push(delivery);
    saveRelays();
    const relay: TeamRelay = { teamId: team.id, teamName: team.name, by, byName: nameOf(by) };
    const open = x;
    postAndRoute(to.id, teamFrom(team.id), msg.text, {
      messageId: delivery.id,
      relay,
      attachments: msg.attachments || [],
      route: brainHandlers?.route || null,
    })
      .then((posted) => {
        if (!relays.includes(open)) return;
        if (!joins) open.postedId = posted.id;
        saveRelays();
        if (idle(runtime(to.id))) settled(to.id);
        log('team', `${team.name} asked ${to.name}`);
      })
      .catch((e: unknown) => {
        if (!joins && relays.includes(open)) closeRelay(open);
        post(team, { from: 'system', text: `Couldn't ask #${to.name}: ${errText(e)}` });
        settled(team.id);
      });
  }
  if (refused.length) {
    why.push(
      `Not sent to ${refused.join(', ')}: ${depth > MAX_RELAY_DEPTH ? `teams are already asking teams ${MAX_RELAY_DEPTH} deep. Answer here instead.` : `this team asked other teams ${MAX_RELAYS} times on this. Write in the chat to keep going.`}`,
    );
  }
  for (const line of why) post(team, { from: 'system', text: line });
  return sent;
}

// Does team `a` wait for an answer from team `b` (in project pid), directly or through teams it asked?
function waitsOn(pid: string, a: string, b: string): boolean {
  const seen = new Set<string>();
  const next = [a];
  while (next.length) {
    const cur = next.pop()!;
    for (const x of relays) {
      if (x.pid !== pid || x.from !== cur || seen.has(x.to)) continue;
      if (x.to === b) return true;
      seen.add(x.to);
      next.push(x.to);
    }
  }
  return false;
}

// A team went quiet: the questions other teams asked it get its answer (its last reply since), unless it
// still waits on a team it asked itself.
function answerRelays(teamId: string, stopped: boolean) {
  // (a question still on its way there isn't in its chat yet)
  const pid = activeProject().id;
  if (!stopped && Object.values(loadChat(teamId).sessions).some((id) => hasBackgroundWork(id))) return;
  const brief = openBrief('team', teamId);
  if (!stopped && brief && (getSettings().brainFollowsUp !== false || !brief.automatic)) return;
  const waiting = relays.filter((x) => x.pid === pid && x.to === teamId && x.postedId);
  if (!waiting.length || (!stopped && relays.some((x) => x.pid === pid && x.from === teamId))) return;
  const team = getTeam(teamId);
  const thread = team ? loadChat(teamId).messages : [];
  for (const x of waiting) {
    const asker = getTeam(x.from);
    // Each relay stays in the project that owns both teams.
    if (!team || !asker) {
      closeRelay(x);
      continue;
    }
    const at = thread.findIndex((m) => m.id === x.postedId);
    const answer =
      at < 0 ? undefined : thread.slice(at + 1).findLast((m) => m.from === BRAIN || team.members.includes(m.from));
    if (stopped || !answer) {
      post(asker, {
        id: `relay-error-${x.id}`,
        from: 'system',
        text: `#${team.name} ${stopped ? 'was stopped before it answered' : 'finished without an answer'}.`,
      });
      closeRelay(x);
      settled(asker.id);
      continue;
    }
    const text = answer.text.length > ANSWER_CHARS ? `${answer.text.slice(0, ANSWER_CHARS)}…` : answer.text;
    const out = post(asker, {
      id: `relay-answer-${x.id}`,
      from: teamFrom(team.id),
      text,
      replyTo: x.askId,
      ...(answer.attachments?.length ? { attachments: answer.attachments } : {}),
      relay: { teamId: team.id, teamName: team.name, by: answer.from, byName: nameOf(answer.from), answers: x.askId },
    });
    log('team', `${team.name} answered ${asker.name}`);
    // the agent that asked picks it up (you read it yourself)
    if (asker.members.includes(x.by)) enqueue(asker, x.by, out.id, false, x.returning, x.skills);
    closeRelay(x);
    if (!asker.members.includes(x.by)) settled(asker.id);
  }
}

// Questions from a team that was stopped or cleared: no answer is wanted any more. Cleared: the
// questions it was asked are gone too, and the teams that asked hear so.
function dropRelays(teamId: string, { cleared }: { cleared: boolean }) {
  const pid = activeProject().id;
  for (const x of [...relays]) {
    if (x.pid !== pid || (x.from !== teamId && !(cleared && x.to === teamId))) continue;
    closeRelay(x);
    const asker = x.to === teamId ? getTeam(x.from) : null;
    if (asker) {
      post(asker, {
        from: 'system',
        text: `#${getTeam(teamId)?.name || 'That team'}'s chat was cleared before it answered.`,
      });
      settled(asker.id);
    }
  }
}

// The Brain answers a message that mentions @Brain, in the thread. Its answer goes to whoever it names,
// else back to the agent that asked. One answer at a time; a few per message you send.
async function brainTurn(team: Team, msg: TeamMessage): Promise<void> {
  const r = runtime(team.id);
  if (!brainHandlers) return;
  if (r.running.has(BRAIN)) {
    r.brainQueue = [...(r.brainQueue || []), { msg, epoch: r.epoch }];
    state(team);
    return;
  }
  const n = r.episode.brain || 0;
  if (n >= MAX_BRAIN_REPLIES) {
    post(team, { from: 'system', text: `The Brain has answered ${n} times on this. Write in the chat to keep going.` });
    return;
  }
  r.episode.brain = n + 1;
  const epoch = r.epoch;
  r.running.add(BRAIN);
  r.brainCurrent = msg;
  state(team);
  let reply: string | null = null;
  try {
    reply =
      loadChat(team.id).messages.find((m) => m.id === `brain-${msg.id}`)?.text ??
      (await brainHandlers.reply(team, msg));
  } catch (e) {
    reply = `(The Brain couldn't answer: ${(e as Error).message})`;
  } finally {
    r.running.delete(BRAIN);
  }
  if (isStopping()) {
    if (r.epoch === epoch && !r.stopped) (r.brainInterrupted ||= []).push(msg);
    r.brainCurrent = undefined;
    state(team);
    return;
  }
  // Stop and Clear invalidate the answer; opening another project does not.
  if (reply && r.epoch === epoch && !r.stopped) {
    const fresh = getTeam(team.id) || team;
    const mentions = parseMentions(fresh, reply);
    const out = post(fresh, { id: `brain-${msg.id}`, from: BRAIN, text: reply, mentions, replyTo: msg.id });
    enqueueMany(fresh, mentions, out.id);
    if (!mentions.length && fresh.members.includes(msg.from)) enqueue(fresh, msg.from, out.id, false, true);
  }
  r.brainCurrent = undefined;
  state(team);
  // (this answer may be for a thread cleared meanwhile: the @Brain messages written since still go next)
  r.brainQueue = (r.brainQueue || []).filter((q) => q.epoch === r.epoch);
  const next = r.stopped ? undefined : r.brainQueue.shift();
  state(team);
  if (next) return brainTurn(getTeam(team.id) || team, next.msg);
  r.brainQueue = [];
  settled(team.id);
}

// Nobody works and nothing waits: the Brain may look at what the team did.
function settled(teamId: string, stopped = false) {
  const r = runtime(teamId);
  if (!r.running.size && r.recovered) {
    stopTeamWork(teamId);
    return;
  }
  if (r.running.size || r.queue.length || r.pending?.length || r.steering || r.brainQueue?.length) return;
  // teams that asked this one get its answer
  answerRelays(teamId, stopped || !!r.stopped);
  try {
    brainHandlers?.idle(teamId, { stopped: stopped || !!r.stopped });
  } catch {
    /* the Brain's problem is not the team's */
  }
  // your next /queue message goes now (the Brain's check of the work then waits for it), then the loop's
  releaseHeld(teamId);
  loopSettled(teamId);
}

export function teamBackgroundFinished(teamId: string, blocked = false): void {
  settled(teamId, blocked);
}

// returning: this is a finished handoff coming back (the receiver's own reply won't bounce back again)
// skills: extra skills for the work this message is about (merged when a queued turn takes on more messages)
function enqueue(
  team: Team,
  agentId: string,
  msgId: string,
  priority = false,
  returning = false,
  skills: readonly string[] = [],
) {
  enqueueMany(team, [agentId], msgId, priority, returning, skills);
}

// Queue the whole assignment before starting anyone, so even the first prompt knows its peers.
function enqueueMany(
  team: Team,
  agentIds: readonly string[],
  msgId: string,
  priority = false,
  returning = false,
  skills: readonly string[] = [],
) {
  if (!agentIds.length) return;
  const r = runtime(team.id);
  const added: QueueItem[] = [];
  for (const agentId of new Set(agentIds)) {
    if (!team.members.includes(agentId)) continue;
    const key = JSON.stringify([agentId, msgId]);
    if (r.assigned?.has(key)) continue;
    (r.assigned ||= new Set()).add(key);
    const existing = r.queue.find((q) => q.agentId === agentId && !q.delivery);
    if (existing) {
      if (!existing.msgIds.includes(msgId)) existing.msgIds.push(msgId);
      existing.returning = existing.returning && returning;
      existing.skills = [...new Set([...existing.skills, ...skills])];
    } else added.push({ agentId, msgIds: [msgId], returning, skills: [...skills] });
  }
  if (priority) r.queue.unshift(...added);
  else r.queue.push(...added);
  state(team);
  pump(team.id);
}

// Start a turn for every queued agent that isn't already working (one turn at a time per agent).
function pump(teamId: string) {
  const r = runtime(teamId);
  if (r.stopped || r.recovered || r.steering || isStopping()) return;
  for (const item of [...r.queue]) {
    if (r.running.has(item.agentId)) continue;
    r.queue.splice(r.queue.indexOf(item), 1);
    const team = getTeam(teamId);
    if (!team || !team.members.includes(item.agentId)) continue;
    // stop runaway back-and-forth: agents handing it around without doing anything
    if ((r.episode.chatter || 0) >= MAX_CHATTER) {
      // (/resume picks these up again, with a fresh budget)
      r.interrupted = [item, ...r.queue];
      r.queue = [];
      post(team, {
        from: 'system',
        text: `Paused: the last ${r.episode.chatter} replies were only talk, with no work done. Reply to keep going, or mention someone to continue.`,
      });
      state(team);
      return;
    }
    r.episode.turns++;
    r.running.add(item.agentId);
    (r.current ||= new Map()).set(item.agentId, item);
    state(team);
    followTurn(team, item);
  }
}

function followTurn(team: Team, item: QueueItem, native?: Promise<string>) {
  const r = runtime(team.id);
  // The turn and what follows it stay in this project, even if you open another meanwhile.
  const end: Promise<void> = withProject(activeProject(), () =>
    runTurn(team, item, native).finally(() => {
      const saved = item.delivery && readEveRun(item.delivery.runId);
      const durable = isStopping() && saved && ['queued', 'running', 'waiting'].includes(saved.status);
      if (isStopping() && !durable && r.current?.get(item.agentId) === item) (r.interrupted ||= []).push(item);
      r.running.delete(item.agentId);
      if (!durable && r.current?.get(item.agentId) === item) r.current.delete(item.agentId);
      if (r.ends?.get(item.agentId) === end) r.ends.delete(item.agentId);
      state(team);
      if (isStopping()) return;
      pump(team.id);
      settled(team.id);
    }),
  );
  (r.ends ||= new Map()).set(item.agentId, end);
}

/** Every team turn ends with this: the briefing comes only on an agent's first turn, so the key rules are repeated here. */
export const TURN_ASK =
  "Do your part now and finish it: install what you need, ask for tools you don't have with request_tool (and the user with ask_user for access or keys), and don't wait on teammates for work you can do yourself. Then reply to the team.";

export function briefing(team: Team, agent: Agent): string {
  const roster = team.members
    .map((id) => agents.get(id))
    .filter((a): a is Agent => Boolean(a))
    .map((a) => {
      const services = servicesOf(a);
      return `- @${a.name}${a.id === team.lead ? ' (lead)' : ''}${a.id === agent.id ? ' (you)' : ''}: ${a.specialty || a.description || ''}${services.length ? ` (has ${services.join(', ')})` : ''}`;
    })
    .join('\n');
  const others = otherTeams(team.id);
  const teamsNote = others.length
    ? `\n\nOther teams in this project:\n${others.map((t) => `- #${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n')}

Talking to other teams:
- To ask another team for something that is their work, write #Team Name in your reply (exactly as above) and say precisely what you need back. Your message goes to their chat, and their answer comes back here to you once they are done.
- A message from another team (#Name asks your team) is a request: handle it like one from the user. When your team is done, its last reply goes back to them by itself.`
    : '';
  // a team that builds in the voxel world: everyone on it (not only the builders) knows what that world is
  const builds = team.members.some((id) => agents.get(id)?.toolGroups?.includes('world'));
  return `You are in the team chat "${team.name}".${team.description ? `\nTeam goal: ${team.description}` : ''}
Team members:
${roster}${teamsNote}${builds ? `\n\nThis team builds in the voxel world. ${DIORAMA}\n${BUILD_ORDER} Plan and hand out the work in that order.` : ''}

How this chat works:
- Everyone sees the whole thread. Your reply is posted to the team as a message from you.
- To hand work to a teammate, mention them exactly as @Name and say precisely what you need back. Only mention someone who needs to act now; each stage should have one owner.
- Do your own part fully before handing off. Don't redo work a teammate owns.
- A task you hand to a teammate is theirs: don't also do it yourself, and don't give the same task to two people. Work that needs something only one member has (see "has" above) goes to that member.
- Anything that needs the user's judgment or help, or that only they can unblock: ask them with ask_user (with short choices to click), not only in your reply, and don't mention a teammate for it.
- The Brain (the project's overseer) hands the team work and checks on it. To ask it something (about the project, other teams, what to do next) or to say you're stuck, write @Brain.

Finishing the work:
- Work you're given is yours to finish. Don't decline it, don't stop partway, and don't reply with a plan instead of the result.
- Start your own part now. Don't wait for a teammate to finish theirs first: do everything you can without them, and only then say exactly what you still need from whom.
- If you need a package, library or program, install it and keep going.
- If you need tools you don't have, ask for them with request_tool. For access, a login or a key, ask the user with ask_user. Say exactly what you need, and carry on with whatever you can do meanwhile.
- When something fails, try another way before calling it blocked.
- Stop only when your part is done, or when you're waiting on an answer you asked for.

- Keep replies short: what you did, the result, and who acts next.${team.lead === agent.id ? '\n- You are the lead: break the request down, give each part to one owner, and when everyone is done post the combined result for the user.' : ''}`;
}

async function runTurn(team: Team, item: QueueItem, native?: Promise<string>) {
  const agent = agents.get(item.agentId);
  if (!agent) return;
  const pid = activeProject().id;
  const epoch = runtime(team.id).epoch;
  const c = loadChat(team.id);
  // the agent's own memory of this team: one chat session per agent per team
  let chatId = c.sessions[agent.id];
  let created = false;
  if (!chatId || !chats.get(agent.id, chatId)) {
    chatId = chats.create(agent.id, `Team: ${team.name}`, team.id, privateTeamRecord(team.id)?.conversationId).id;
    c.sessions[agent.id] = chatId;
    created = true;
  }
  const first = created || c.seen[agent.id] == null;
  // Stable source ids survive compaction. Older clipped sessions import the retained transcript once.
  const history = chats.get(agent.id, chatId)?.items || [];
  const reset = history.findLastIndex((i) => i.type === 'meta' && i.reset);
  const imported = new Set(
    history
      .slice(reset + 1)
      .flatMap((i) => ((i.type === 'user' || i.type === 'steer') && i.teamMessageId ? [i.teamMessageId] : [])),
  );
  const fresh = c.messages.filter((m) => !imported.has(m.id));
  const name = (m: TeamMessage) => {
    const id = m.from;
    if (m.relay)
      return m.relay.answers
        ? `#${m.relay.teamName} answered (${m.relay.byName} there)`
        : `#${m.relay.teamName} asks your team (${m.relay.byName} there)`;
    return id === 'user'
      ? m.sender || 'You (the user)'
      : id === 'system'
        ? 'System'
        : id === BRAIN
          ? 'The Brain (overseer)'
          : `@${agents.get(id)?.name || 'someone'}`;
  };
  const said = (m: TeamMessage) => teamMessage(m, name);
  const forYou = c.messages
    .filter((m) => item.msgIds.includes(m.id))
    .map(said)
    .join('\n\n');
  // the team's files go to the engine once per agent (so models that can't open files get them too), new ones when added;
  // plus what the user attached since this agent last read
  // (only this project's uploads: a team or thread restored from a saved folder or backup could name any file on the PC)
  const teamFiles = cleanAttachments(team.files);
  const given = new Set(c.filesSent?.[agent.id] || []);
  const newTeamFiles = teamFiles.filter((f) => !given.has(f));
  const attachments = cleanAttachments([
    ...new Set([
      ...newTeamFiles,
      ...[...fresh, ...c.messages.filter((m) => item.msgIds.includes(m.id))].flatMap((m) => m.attachments || []),
    ]),
  ]);
  saveChat(team.id, c);
  const filesNote = newTeamFiles.length
    ? `The team's reference files from the user (${attachmentNames(newTeamFiles)}) are attached at the end.\n\n`
    : teamFiles.length
      ? `The team's files: ${teamFiles.join(', ')}\n\n`
      : '';
  const assigned = [...(runtime(team.id).current?.values() || []), ...runtime(team.id).queue];
  const peers = [
    ...new Set(
      assigned
        .filter(
          (q) =>
            q.agentId !== agent.id &&
            team.members.includes(q.agentId) &&
            q.msgIds.some((id) => item.msgIds.includes(id)),
        )
        .map((q) => q.agentId),
    ),
  ];
  const peersNote = peers.length
    ? `Other members assigned this message: ${peers.map((id) => `@${agents.get(id)?.name || 'someone'}`).join(', ')}. Do your own part; avoid duplicating theirs.\n\n`
    : '';
  const prompt = `${first ? `${briefing(team, agent)}\n\n` : ''}${filesNote}The shared team messages are in your conversation history, with their original text and [team message id] references. Use search_conversations and read_conversation to find and read earlier conversations after compaction.\n\n---\nAddressed to you:\n${forYou}\n\n${peersNote}${TURN_ASK}`;
  // (where this turn starts in the agent's session: the team chat shows its work, live and afterwards)
  const from = chats.get(agent.id, chatId)?.items.length ?? 0;
  const saved =
    item.delivery &&
    readExecution().runs.find(
      (run) =>
        run.id === item.delivery!.runId &&
        run.projectId === pid &&
        run.agentId === agent.id &&
        run.chatId === chatId &&
        run.status === 'completed',
    );
  if (!saved && !native) {
    item.delivery = { runId: uid('r'), chatId, from, readUpto: c.messages.length, files: teamFiles };
    state(team);
  }
  const delivery = item.delivery!;
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'start', chatId } });
  let text = '';
  let stopped = false;
  try {
    text = native
      ? await native
      : saved
        ? saved.answer || '(no answer)'
        : await askAgent(agent, prompt, {
            depth: 1,
            from: `team ${team.name}`,
            chatId,
            parentRunId: teamRunId(team.id),
            reservedRunId: delivery.runId,
            extra: { ...(team.access || {}), skills: [...new Set([...(team.skills || []), ...item.skills])] },
            attachments,
            context: fresh.map((m) => ({ id: m.id, text: said(m), from: name(m), ts: m.ts })),
          });
    // Read marks and file delivery only advance after a successful turn, never on a failed request.
    const delivered = loadChat(team.id, pid);
    if (runtime(team.id).epoch === epoch && delivered.sessions[agent.id] === chatId) {
      delivered.seen[agent.id] = Math.max(delivered.seen[agent.id] || 0, delivery.readUpto);
      delivered.filesSent = { ...delivered.filesSent, [agent.id]: delivery.files };
      saveChat(team.id, delivered, pid);
    }
  } catch (e) {
    // you stopped this agent's turn: say so in the thread, and hand nothing on
    stopped = e instanceof RunStopped;
    // (stopped by a new message from you: it picks that up next, with what it did so far)
    text = stopped
      ? item.steered
        ? '(stopped to take your new message)'
        : '(stopped)'
      : `(I hit a problem: ${(e as Error).message})`;
  }
  const r = runtime(team.id);
  if (isStopping()) return;
  if (r.stopped || r.epoch !== epoch) {
    // stopped or cleared meanwhile: if cleared, don't let this turn bring the agent's session back
    // (a conversation filed away by New chat keeps its sessions, for when it is opened again)
    if (loadChat(team.id, pid).sessions[agent.id] !== chatId && !filedSession(team.id, agent.id, chatId, pid))
      chats.remove(agent.id, chatId);
    return;
  }
  // your messages sent into its turn that it ended before reading leave that turn, so it doesn't show them as
  // read nor count them as had (before the reply marks where the turn's work ends)
  const missed = await missedMessages(delivery.runId);
  const session = missed.some((m) => m.steerId) ? chats.get(agent.id, chatId) : null;
  if (session) {
    const ids = new Set(missed.map((m) => m.steerId));
    session.items = session.items.filter((i) => !(i.type === 'steer' && ids.has(i.steerId)));
    chats.save(session);
  }
  // (a stopped turn hands nothing on)
  const mentions = stopped ? [] : parseMentions(team, text, agent.id);
  const to = chats.get(agent.id, chatId)?.items.length ?? from;
  const msg = post(team, {
    id: `reply-${delivery.runId}`,
    from: agent.id,
    text: text || '(no answer)',
    mentions,
    ...(to > delivery.from ? { turn: { chatId, from: delivery.from, to } } : {}),
    ...(stopped ? { stopped: item.steered ? ('steer' as const) : ('stop' as const) } : {}),
  });
  const worked =
    text.length >= CHATTER_CHARS ||
    (chats.get(agent.id, chatId)?.items.slice(delivery.from, to) || []).some((i) => i.type === 'tool');
  r.episode.chatter = worked ? 0 : (r.episode.chatter || 0) + 1;
  // (its read mark stays where this turn started: what others wrote meanwhile is new to it next turn;
  // its own reply is left out of that by itself)
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'end' } });
  // your messages sent into its turn that it ended before reading: it takes them next, as an ordinary turn
  for (const m of missed) if (m.teamMessageId) enqueue(team, agent.id, m.teamMessageId, true, false, item.skills);
  if (stopped) return;
  enqueueMany(team, mentions, msg.id, false, false, item.skills);
  // it asked the Brain: the Brain's answer comes back to it
  const askedBrain = mentionsBrain(text);
  if (askedBrain) void brainTurn(team, msg);
  // it asked other teams (#Team Name): their answers come back to it
  const named = teamsNamed(team, text);
  const askedTeams =
    named.length > 0 &&
    askTeams(team, msg, named, agent.id, { returning: item.returning, skills: item.skills }).length > 0;
  // A handed-off job is done and nobody new is named: the answer goes back to the lead (or whoever asked), once.
  if (!mentions.length && !askedBrain && !askedTeams && !item.returning && agent.id !== team.lead) {
    const asked = c.messages
      .filter(
        (m) =>
          item.msgIds.includes(m.id) &&
          m.from !== 'user' &&
          m.from !== 'system' &&
          m.from !== BRAIN &&
          !fromTeam(m.from),
      )
      .map((m) => m.from);
    const back = team.lead && team.lead !== agent.id ? team.lead : asked.find((id) => id !== agent.id);
    if (asked.length && back && team.members.includes(back)) enqueue(team, back, msg.id, false, true, item.skills);
  }
}

// ---------- steering: your message while the team works ----------
/** How long a steer waits for the turns it stopped to end before posting anyway. */
const STEER_WAIT_MS = 10_000;

/** A message sent while the team works changes its course: the turns going now stop, and whoever was
 *  working picks it up next (with what they did so far in their session), unless it names someone.
 *  Your /queue messages keep waiting. Nobody working: an ordinary message. */
export function steerTeam(
  teamId: string,
  text: string | null | undefined,
  opts: PostOptions = {},
): Promise<TeamMessage> {
  return here(() => steerIn(teamId, text, opts));
}

function steerIn(teamId: string, text: string | null | undefined, opts: PostOptions): Promise<TeamMessage> {
  const team = getTeam(teamId);
  if (!team) return Promise.reject(new Error('No such team.'));
  const r = runtime(team.id);
  const mine = (r.steers || Promise.resolve()).then(() => steerNow(team, text, opts));
  const tail = mine.then(
    () => {},
    () => {},
  );
  r.steers = tail;
  void tail.then(() => r.steers === tail && (r.steers = undefined));
  return mine;
}

async function steerNow(team: Team, text: string | null | undefined, opts: PostOptions): Promise<TeamMessage> {
  const r = runtime(team.id);
  const working = [...r.running].filter((id) => team.members.includes(id));
  // (checked before anything stops: an empty message mustn't cut the work off)
  if (!working.length || (!String(text || '').trim() && !opts.attachments?.length))
    return postUserMessage(team.id, text, opts);
  const sessions = loadChat(team.id).sessions;
  r.steering = true;
  const messageId = opts.messageId || uid('m');
  const body = String(text || '').trim();
  // (saved before anything waits, for a restart: then everyone working gets it the ordinary way)
  (r.pending ||= []).push({
    id: messageId,
    from: 'user',
    text: body,
    replyTo: opts.replyTo || null,
    attachments: opts.attachments || [],
    skills: opts.skills || [],
    to: working,
    track: opts.track !== false,
  });
  state(team);
  // Whoever is working takes it into the turn they are on, when their engine can (nothing stops): a message
  // for them, not one that names someone, replies to a message, or asks the Brain or another team.
  const joined: string[] = [];
  const plain =
    !parseMentions(team, body).length && !opts.replyTo && !mentionsBrain(body) && !teamsNamed(team, body).length;
  if (plain) {
    const sender = opts.sender || 'You (the user)';
    const said = teamMessage(
      {
        id: messageId,
        ts: Date.now(),
        from: 'user',
        text: body,
        mentions: [],
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      },
      () => sender,
    );
    try {
      for (const id of working)
        if (
          sessions[id] &&
          (await joinChatTurn(sessions[id], {
            text: said,
            attachments: opts.attachments || [],
            from: sender,
            teamMessageId: messageId,
          }))
        )
          joined.push(id);
    } catch {
      /* not taken: they stop for it below */
    }
  }
  const stopping = working.filter((id) => !joined.includes(id));
  for (const id of stopping) {
    const turn = r.current?.get(id);
    if (turn) turn.steered = true;
  }
  try {
    for (const id of stopping) {
      if (sessions[id]) stopChat(sessions[id], undefined, { forMessage: true });
    }
    // their "(stopped…)" replies land before your message, so the thread reads in order
    await settledWithin(
      stopping.map((id) => r.ends?.get(id)),
      STEER_WAIT_MS,
    );
  } finally {
    r.steering = false;
  }
  try {
    return await postAndRoute(team.id, 'user', text, { ...opts, messageId, to: stopping, joined });
  } finally {
    // (whatever waited while the turns ended goes on now)
    pump(team.id);
    settled(team.id);
  }
}

// ---------- /queue: your messages that wait until the team is done ----------
const idle = (r: Runtime) => !r.running.size && !r.queue.length && !r.pending?.length && !r.releasing && !r.steering;

/** Post now if nobody is working, else once the whole team is done (one held message at a time). */
export async function queueUserMessage(
  teamId: string,
  text: string | null | undefined,
  {
    replyTo = null,
    route = null,
    attachments = [],
  }: { replyTo?: string | null; route?: RouteFn | null; attachments?: string[] } = {},
): Promise<{ message: TeamMessage } | { queued: QueuedMessage }> {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  text = String(text || '').trim();
  if (!text && !attachments.length) throw new Error('Write the message after /queue.');
  const r = runtime(team.id);
  if (idle(r) && !r.held.length)
    return { message: await postUserMessage(team.id, text, { replyTo, route, attachments }) };
  const queued: QueuedMessage = {
    id: uid('q'),
    text,
    ...(attachments.length ? { attachments } : {}),
    ...(replyTo ? { replyTo } : {}),
    ts: Date.now(),
  };
  r.held.push(queued);
  r.heldIn = activeProject().id;
  r.route = route;
  state(team);
  return { queued };
}

/** Take back one held message (id), or all of them. Returns what was taken. */
export function unqueueTeam(teamId: string, id?: string): QueuedMessage[] {
  const r = runtime(teamId);
  const taken = id ? r.held.filter((q) => q.id === id) : r.held;
  r.held = id ? r.held.filter((q) => q.id !== id) : [];
  const team = getTeam(teamId);
  if (taken.length && team) state(team);
  return taken;
}

/** Change the text of a held message (before it is posted). null: it already went. */
export function editQueuedTeam(teamId: string, id: string, text: unknown): QueuedMessage | null {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  const r = runtime(team.id);
  const q = r.held.find((x) => x.id === id);
  if (!q) return null;
  q.text = queuedEdit(text, !!q.attachments?.length);
  state(team);
  return q;
}

/** Put the held messages in this order (ids it doesn't name keep their place after the ones it does). */
export function orderQueuedTeam(teamId: string, ids: unknown): QueuedMessage[] {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  const r = runtime(team.id);
  r.held = reorderQueued(r.held, ids);
  state(team);
  return r.held;
}

// Nobody is working any more: post the next held message.
function releaseHeld(teamId: string) {
  const r = runtime(teamId);
  if (!r.held.length || !idle(r) || r.stopped || r.recovered) return;
  const team = getTeam(teamId);
  // The queue belongs to the project where it was typed.
  if (!team || r.heldIn !== activeProject().id) {
    r.held = [];
    if (team) state(team);
    return;
  }
  const next = r.held[0]!;
  r.releasing = true;
  here(() =>
    postUserMessage(team.id, next.text, {
      messageId: next.id,
      replyTo: next.replyTo || null,
      route: r.route || brainHandlers?.route,
      attachments: next.attachments || [],
    })
      .then(() => {
        r.held = r.held.filter((q) => q.id !== next.id);
      })
      .catch((e: unknown) => {
        r.stopped = true;
        r.recovered = true;
        log('error', `${team.name}: a queued message couldn't be sent: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        r.releasing = false;
        state(team);
        releaseHeld(teamId);
        fireLoop(teamId);
      }),
  );
}

// ---------- /resume, /resend ----------
/** Start again the turns that Stop or the turn limit cut off (with a fresh budget). Returns how many. */
export function resumeTeam(teamId: string): number {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  const r = runtime(team.id);
  const items = (r.interrupted || []).filter((q) => team.members.includes(q.agentId));
  r.interrupted = undefined;
  const pending = [...(r.pending || [])];
  const brain = [...(r.brainInterrupted || [])];
  const relayCount = r.recovered
    ? relays.filter((x) => x.pid === activeProject().id && (x.from === team.id || x.to === team.id)).length
    : 0;
  const count = items.length + pending.length + brain.length + (r.recovered ? r.held.length : 0) + relayCount;
  if (!count) {
    r.recovered = false;
    state(team);
    return 0;
  }
  r.stopped = false;
  r.recovered = false;
  r.episode = { turns: 0 };
  for (const it of items) {
    r.queue.push({ ...it, msgIds: [...it.msgIds] });
  }
  const names = [...new Set(items.map((q) => agents.get(q.agentId)?.name).filter(Boolean))];
  post(team, {
    from: 'system',
    text: names.length
      ? `Resumed: ${names.join(', ')} pick${names.length === 1 ? 's' : ''} up where they left off.`
      : 'Resumed saved messages.',
  });
  log('team', `You resumed ${team.name}`);
  state(team);
  pump(team.id);
  for (const msg of brain) {
    r.brainInterrupted = r.brainInterrupted?.filter((m) => m.id !== msg.id);
    void brainTurn(team, msg);
  }
  for (const input of pending)
    void postAndRoute(team.id, input.from, input.text, {
      ...input,
      messageId: input.id,
      route: brainHandlers?.route,
    }).catch((e: unknown) => {
      r.stopped = true;
      state(team);
      log('error', `${team.name}: a saved message couldn't be sent: ${errText(e)}`);
    });
  resumeRelays(team);
  releaseHeld(team.id);
  if (idle(r) && !r.brainQueue?.length && !r.pending?.length) settled(team.id);
  return count;
}

/** Your last message in the team chat (what /resend sends again). */
export function lastUserMessage(teamId: string): TeamMessage | null {
  return loadChat(teamId).messages.findLast((m) => m.from === 'user') || null;
}

/** A line from the dashboard in the thread (the agents see it too). */
export function postSystem(teamId: string, text: string): void {
  const team = getTeam(teamId);
  if (team) post(team, { from: 'system', text });
}

// ---------- /loop: your message posted again and again ----------
// A timed loop posts every so often (a due one waits until nobody is working); the other kind posts
// again once the team has gone quiet after the last one. Held /queue messages go first.
const loopInfo = (l: TeamLoop | null | undefined): LoopInfo | null =>
  l ? { text: l.text, every: l.every, times: l.times, done: l.done, next: l.next } : null;

export function startTeamLoop(
  teamId: string,
  req: LoopRequest,
  { attachments = [], route = null }: { attachments?: string[]; route?: RouteFn | null } = {},
): LoopInfo {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  stopTeamLoop(team.id, null);
  const r = runtime(team.id);
  r.loop = {
    ...req,
    done: 0,
    next: null,
    project: activeProject().id,
    attachments,
    route,
    due: true,
    timer: null,
    posted: false,
  };
  fireLoop(team.id);
  state(team);
  return loopInfo(r.loop)!;
}

/** End the team's loop. why: the line posted in the thread (null: none). */
export function stopTeamLoop(teamId: string, why: string | null): boolean {
  const r = runtime(teamId);
  const l = r.loop;
  if (!l) return false;
  if (l.timer) clearTimeout(l.timer);
  r.loop = null;
  const team = getTeam(teamId);
  if (team && why) post(team, { from: 'system', text: why });
  if (team) state(team);
  return true;
}

function fireLoop(teamId: string) {
  const r = runtime(teamId);
  const l = r.loop;
  if (!l || !l.due || !idle(r) || r.held.length) return;
  const team = getTeam(teamId);
  // (another project is open now: its threads are the ones in view)
  if (!team || l.project !== openProject().id) return void stopTeamLoop(teamId, null);
  l.due = false;
  l.done++;
  l.posted = true;
  l.next = null;
  r.releasing = true;
  postUserMessage(team.id, l.text, { route: l.route, attachments: l.attachments, track: false })
    .catch((e: unknown) => stopTeamLoop(teamId, `Loop ended: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      r.releasing = false;
      state(team);
    });
  if (l.every != null && l.done < l.times) {
    l.next = Date.now() + l.every;
    const project = activeProject();
    l.timer = setTimeout(
      () =>
        withProject(project, () => {
          l.timer = null;
          l.due = true;
          fireLoop(teamId);
        }),
      l.every,
    );
    l.timer.unref?.();
  }
  state(team);
}

// The team went quiet: the loop's last message is answered. Done, or the next one (now, or when due).
function loopSettled(teamId: string) {
  const r = runtime(teamId);
  const l = r.loop;
  if (!l) return;
  if (l.posted) {
    l.posted = false;
    if (l.done >= l.times)
      return void stopTeamLoop(teamId, `Loop done: sent ${l.times} time${l.times > 1 ? 's' : ''}.`);
    if (l.every == null) l.due = true;
  }
  fireLoop(teamId);
}

/** Take an agent off the turns it waits for in this project's teams (it was stopped, so it doesn't start
 *  on the next one as soon as its turn ends). Returns how many it had. */
export function dropQueuedTurns(agentId: string): number {
  let n = 0;
  const prefix = `${activeProject().id}/`;
  for (const [key, r] of rt) {
    if (!key.startsWith(prefix)) continue; // another project's team
    const teamId = key.slice(prefix.length);
    const team = getTeam(teamId);
    if (!team) continue;
    const before = r.queue.length;
    r.queue = r.queue.filter((q) => q.agentId !== agentId);
    if (r.queue.length === before) continue;
    n += before - r.queue.length;
    state(team);
    settled(teamId);
  }
  return n;
}

export function stopTeam(teamId: string) {
  stopTeamWork(teamId);
  const team = getTeam(teamId);
  const r = runtime(teamId);
  r.stopped = true;
  r.epoch++;
  // what was going or waiting: /resume picks it up again
  const cut = [...(r.current?.values() || []), ...r.queue];
  if (cut.length) {
    const saved = [...cut, ...(r.interrupted || [])];
    r.interrupted = saved.filter(
      (item, index) =>
        saved.findIndex(
          (q) =>
            q.agentId === item.agentId &&
            JSON.stringify(q.msgIds) === JSON.stringify(item.msgIds) &&
            q.delivery?.runId === item.delivery?.runId,
        ) === index,
    );
  }
  r.queue = [];
  r.held = [];
  r.pending = [];
  r.brainInterrupted = [];
  r.brainCurrent = undefined;
  r.brainQueue = [];
  r.recovered = false;
  if (team) state(team);
  stopTeamLoop(teamId, null);
  stopChildren(teamRunId(teamId));
  r.brainQueue = [];
  // (answers to what it asked other teams aren't wanted now; teams that asked it hear it was stopped)
  dropRelays(teamId, { cleared: false });
  if (team) post(team, { from: 'system', text: 'Stopped. Nothing new will start until you write again.' });
  if (team) state(team);
  settled(teamId, true);
  return true;
}

/** Ends the work going on in a team's thread before it is emptied or swapped for another conversation, so nothing
 *  late lands in the next one. */
function endThreadWork(teamId: string): void {
  clearWork('team', teamId);
  // drop queued work and turns still running
  const r = runtime(teamId);
  r.epoch++;
  r.queue = [];
  r.held = [];
  r.interrupted = undefined;
  r.pending = [];
  r.assigned = new Set();
  r.brainInterrupted = [];
  r.brainCurrent = undefined;
  r.brainQueue = [];
  r.current?.clear();
  r.recovered = false;
  r.stopped = true;
  saveRuntime(teamId);
  stopTeamLoop(teamId, null);
  r.episode = { turns: 0 };
  stopChildren(teamRunId(teamId));
  dropRelays(teamId, { cleared: true });
}
// the agents' sessions for a conversation that is gone: they forget it
function dropSessions(sessions: Record<string, string> | undefined): void {
  for (const [agentId, chatId] of Object.entries(sessions || {})) {
    forgetChat(chatId);
    chats.remove(agentId, chatId);
  }
}

export function clearThread(teamId: string) {
  if (!getTeam(teamId)) throw new Error('No such team.');
  endThreadWork(teamId);
  const c = loadChat(teamId);
  writeJSON(chatFile(teamId), { messages: [], sessions: {}, seen: {} });
  dropSessions(c.sessions);
  emit('team', { teamId, event: { kind: 'cleared' } });
}

// ---------- the team's other conversations ----------
// New chat files the thread away (pastchats.ts) with the agents' sessions for it, so they still remember it when
// it is opened again; opening a past one swaps the two. Work going on in the open thread stops either way.
// The team's chat as a place with conversations (pastchats.ts has the steps). A past one holds on to its agents'
// sessions ("agent/chat"), so a turn stopped by the swap doesn't throw away a session it still needs.
const teamPlace = (teamId: string, pid = activeProject().id): ThreadPlace<TeamMessage, TeamChat> => ({
  owner: { kind: 'team', id: teamId },
  pid,
  open: () => loadChat(teamId, pid),
  blank: () => ({ messages: [], sessions: {}, seen: {} }),
  yours: (m) => (m.from === 'user' ? m.text : null),
  holds: (t) => Object.entries(t.sessions || {}).map(([agentId, chatId]) => `${agentId}/${chatId}`),
  leave: (c) => {
    endThreadWork(teamId);
    // (an empty one is just dropped, with any sessions it had)
    if (c.messages.length)
      filePast({ kind: 'team', id: teamId }, { ...c, updatedAt: c.messages.at(-1)?.ts || Date.now() }, pid);
    else dropSessions(c.sessions);
  },
  show: (thread, how) => {
    writeJSON(chatFile(teamId, pid), { ...thread, sessions: thread.sessions || {}, seen: thread.seen || {} });
    emit('team', { teamId, event: how === 'new' ? { kind: 'cleared' } : { kind: 'thread', id: thread.id } });
  },
  clear: () => clearThread(teamId),
  forget: (past) => {
    dropSessions(past.sessions);
    emit('team', { teamId, event: { kind: 'threads' } });
  },
});
/** The thread is no longer open: an agent's session belongs to one of the team's past conversations. */
function filedSession(teamId: string, agentId: string, chatId: string, pid: string): boolean {
  return pastHolds(teamPlace(teamId, pid)).has(`${agentId}/${chatId}`);
}
function checkTeam(teamId: string): void {
  if (!getTeam(teamId)) throw new Error('No such team.');
}

/** The team's conversations: the open one first, then the past ones newest first. */
export function teamThreads(teamId: string): ThreadSummary[] {
  checkTeam(teamId);
  return listThreads(teamPlace(teamId));
}
/** New chat: the thread is kept with the others (work going on in it stops), and the team starts on an empty one. */
export function newTeamThread(teamId: string): { id: string } {
  checkTeam(teamId);
  return startThread(teamPlace(teamId));
}
/** Opens a past conversation: the thread open now takes its place among the others (work going on in it stops). */
export function openTeamThread(teamId: string, id: string): { id: string } {
  checkTeam(teamId);
  return reopenThread(teamPlace(teamId), id);
}
/** Deletes a conversation, and the agents forget it. The open one is emptied (as /clear does). */
export function removeTeamThread(teamId: string, id: string): void {
  checkTeam(teamId);
  deleteThread(teamPlace(teamId), id);
}
