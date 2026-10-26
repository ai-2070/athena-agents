// Teams are group chats of agents. You write in the team chat; the lead (or the best member) answers,
// agents hand work to each other by @mentioning a teammate, and everyone sees one shared thread.
// Each agent keeps its own memory of the team (its own chat session), and gets the new messages each turn.
// The Brain writes here too: it hands the team work, answers when someone writes @Brain, and looks at
// the thread when the team goes quiet (see irc.ts).
import { workflows as teamStore, agents, chats, emit, log, activeProject, openProject } from './store.ts';
import { readJSON, writeJSON, uid, dataPath } from './util.ts';
import { askAgent, stopChildren, forgetChat, RunStopped } from './engines/index.ts';
import { isStepList, teamSteps } from '../shared/teams.ts';
import { attachmentNames } from './uploads.ts';
import type { Agent, QueuedMessage, Team, TeamMessage, TeamState } from '../shared/types.ts';

const MAX_TURNS = 16; // agent turns per message you send
const MAX_PER_AGENT = 5; // turns per agent per message you send
const CONTEXT_CHARS = 9000; // new group messages handed to an agent per turn
const KEEP_MESSAGES = 500;
const MAX_BRAIN_REPLIES = 4; // times the Brain answers @Brain per message you send
/** Who the Brain is in a thread (TeamMessage.from, and in TeamState.working while it answers). */
export const BRAIN = 'brain';

/** The team chat file: the shared thread, each agent's own chat session, and how far each agent has read. */
interface TeamChat {
  messages: TeamMessage[];
  sessions: Record<string, string>; // agentId -> chatId
  seen: Record<string, number>; // agentId -> messages.length when it last read
  filesSent?: Record<string, string[]>; // agentId -> the team files it has been given
}

/** A message before post() gives it an id and a time. */
interface NewMessage {
  from: string;
  text: string;
  mentions?: string[];
  replyTo?: string | null;
  attachments?: string[];
  turn?: TeamMessage['turn'];
}

interface QueueItem {
  agentId: string;
  msgIds: string[];
  returning: boolean;
  /** extra skills for this work (a routine's), passed on with every handoff it leads to */
  skills: string[];
}

interface Runtime {
  queue: QueueItem[];
  running: Set<string>;
  episode: { turns: number; per: Record<string, number>; brain?: number };
  stopped?: boolean;
  epoch: number; // bumped by stop and clear: turns started before then are dropped
  /** your /queue messages, posted one by one once nobody is working; heldIn: the project they were typed in */
  held: QueuedMessage[];
  heldIn?: string;
  route?: RouteFn | null;
  /** a held message is being posted */
  releasing?: boolean;
  /** @Brain messages waiting while the Brain answers another one */
  brainQueue?: TeamMessage[];
}

/** Picks the member who should answer when nobody is named and there is no lead (brain.pickMember). */
export type RouteFn = (text: string, members: (Agent | null)[]) => Promise<string | null | undefined>;

/** What the Brain does in team chats (irc.ts sets these): answer a message that mentions @Brain
 *  (the reply text, posted here as the Brain), and look at a team that went quiet. */
export interface BrainHandlers {
  reply(team: Team, msg: TeamMessage): Promise<string | null>;
  idle(teamId: string, opts: { stopped: boolean }): void;
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
    team.members = [...new Set((team.steps || []).filter((s) => s.type === 'agent' && s.agentId).map((s) => s.agentId as string))];
  }
  team.members = team.members.filter((id) => agents.get(id));
  if (team.lead && !team.members.includes(team.lead)) team.lead = null;
  return team;
}

export function getTeam(id: string | null | undefined): Team | null {
  return normalize(teamStore.get(id));
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
  if (c.messages.length > KEEP_MESSAGES) {
    const cut = c.messages.length - KEEP_MESSAGES;
    c.messages = c.messages.slice(cut);
    for (const k of Object.keys(c.seen)) c.seen[k] = Math.max(0, c.seen[k] - cut);
  }
  writeJSON(chatFile(teamId, pid), c);
}

// ---------- who is working ----------
const rt = new Map<string, Runtime>(); // teamId -> { queue: [{agentId, msgIds}], running: Set, episode: {turns, per}, stopped }
function runtime(teamId: string): Runtime {
  if (!rt.has(teamId)) rt.set(teamId, { queue: [], running: new Set(), episode: { turns: 0, per: {} }, epoch: 0, held: [] });
  return rt.get(teamId)!;
}

export function teamState(teamId: string): TeamState {
  const r = runtime(teamId);
  return { working: [...r.running], queued: [...new Set(r.queue.map((q) => q.agentId))], held: [...r.held] };
}

export function getThread(teamId: string, limit = 200): TeamState & { messages: TeamMessage[]; sessions: Record<string, string> } {
  const c = loadChat(teamId);
  // (each agent's own session for this team: where a working agent's turn streams from)
  return { messages: c.messages.slice(-limit), ...teamState(teamId), sessions: { ...c.sessions } };
}

function post(team: Team, msg: NewMessage): TeamMessage {
  const c = loadChat(team.id);
  const full: TeamMessage = { id: uid('m'), ts: Date.now(), mentions: [], ...msg };
  c.messages.push(full);
  saveChat(team.id, c);
  emit('team', { teamId: team.id, event: { kind: 'message', message: full } });
  return full;
}

const state = (team: Team) => emit('team', { teamId: team.id, event: { kind: 'state', ...teamState(team.id) } });

// @Name (exact member names, longest first), plus @everyone / @all / @team.
export function parseMentions(team: Team, text: unknown, exclude: string | null = null): string[] {
  const t = String(text || '');
  const found = new Set<string>();
  if (/(^|\s)@(everyone|all|team)\b/i.test(t)) team.members.forEach((id) => found.add(id));
  const named = team.members.map((id) => agents.get(id))
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
  replyTo?: string | null;
  route?: RouteFn | null;
  /** given to every member for the work this message starts (a routine's skills) */
  skills?: string[];
  attachments?: string[];
}

export function postUserMessage(teamId: string, text: string | null | undefined, opts: PostOptions = {}): Promise<TeamMessage> {
  return postAndRoute(teamId, 'user', text, opts);
}

/** The Brain hands the team work (or follows up on it), as itself. */
export function postBrainMessage(teamId: string, text: string | null | undefined, opts: PostOptions = {}): Promise<TeamMessage> {
  return postAndRoute(teamId, BRAIN, text, opts);
}

async function postAndRoute(teamId: string, from: 'user' | typeof BRAIN, text: string | null | undefined, { replyTo = null, route = null, skills = [], attachments = [] }: PostOptions): Promise<TeamMessage> {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  text = String(text || '').trim();
  if (!text && !attachments.length) throw new Error('Write something first.');
  const mentions = parseMentions(team, text);
  const msg = post(team, { from, text, mentions, replyTo, ...(attachments.length ? { attachments } : {}) });
  const r = runtime(team.id);
  r.episode = { turns: 0, per: {} }; // a new message from you gives the team a fresh budget
  r.stopped = false;
  // you asked the Brain: it answers in the thread, and nobody else starts unless you named them
  const askBrain = from === 'user' && mentionsBrain(text);
  if (askBrain) void brainTurn(team, msg);
  let targets = mentions;
  let why = '';
  if (!targets.length && askBrain) {
    log('team', `You → the Brain in ${team.name}: ${text.slice(0, 100)}`);
    return msg;
  }
  if (!targets.length && replyTo) {
    const parent = loadChat(team.id).messages.find((m) => m.id === replyTo);
    if (parent && team.members.includes(parent.from)) targets = [parent.from];
  }
  if (!targets.length && team.lead) {
    targets = [team.lead];
    why = 'the lead';
  }
  if (!targets.length) {
    // files only: route on their names
    const pick = route ? await route(text || `(attached: ${attachmentNames(attachments)})`, team.members.map((id) => agents.get(id))).catch(() => null) : null;
    targets = [pick && team.members.includes(pick) ? pick : team.members[0]];
    why = pick ? 'best fit' : 'first member';
  }
  for (const id of targets) enqueue(team, id, msg.id, true, false, skills);
  if (why) emit('team', { teamId: team.id, event: { kind: 'routed', to: targets, why } });
  log('team', `${from === BRAIN ? 'The Brain' : 'You'} → ${team.name}: ${(text || attachmentNames(attachments)).slice(0, 100)}`);
  return msg;
}

// The Brain answers a message that mentions @Brain, in the thread. Its answer goes to whoever it names,
// else back to the agent that asked. One answer at a time; a few per message you send.
async function brainTurn(team: Team, msg: TeamMessage): Promise<void> {
  const r = runtime(team.id);
  if (!brainHandlers) return;
  if (r.running.has(BRAIN)) {
    r.brainQueue = [...(r.brainQueue || []), msg];
    return;
  }
  const n = r.episode.brain || 0;
  if (n >= MAX_BRAIN_REPLIES) {
    post(team, { from: 'system', text: `The Brain has answered ${n} times on this. Write in the chat to keep going.` });
    return;
  }
  r.episode.brain = n + 1;
  const epoch = r.epoch;
  const pid = activeProject().id;
  r.running.add(BRAIN);
  state(team);
  let reply: string | null = null;
  try {
    reply = await brainHandlers.reply(team, msg);
  } catch (e) {
    reply = `(The Brain couldn't answer: ${(e as Error).message})`;
  } finally {
    r.running.delete(BRAIN);
  }
  // stopped, cleared or another project opened meanwhile: the answer is no longer wanted here
  if (reply && r.epoch === epoch && !r.stopped && openProject().id === pid) {
    const fresh = getTeam(team.id) || team;
    const mentions = parseMentions(fresh, reply);
    const out = post(fresh, { from: BRAIN, text: reply, mentions, replyTo: msg.id });
    for (const id of mentions) enqueue(fresh, id, out.id, false, false);
    if (!mentions.length && fresh.members.includes(msg.from)) enqueue(fresh, msg.from, out.id, false, true);
  }
  state(team);
  const next = r.brainQueue?.shift();
  if (next && r.epoch === epoch && !r.stopped) return brainTurn(team, next);
  r.brainQueue = [];
  settled(team.id);
}

// Nobody works and nothing waits: the Brain may look at what the team did.
function settled(teamId: string, stopped = false) {
  const r = runtime(teamId);
  if (r.running.size || r.queue.length) return;
  try {
    brainHandlers?.idle(teamId, { stopped: stopped || !!r.stopped });
  } catch {
    /* the Brain's problem is not the team's */
  }
  // your next /queue message goes now (the Brain's check of the work then waits for it)
  releaseHeld(teamId);
}

// returning: this is a finished handoff coming back (the receiver's own reply won't bounce back again)
// skills: extra skills for the work this message is about (merged when a queued turn takes on more messages)
function enqueue(team: Team, agentId: string, msgId: string, priority = false, returning = false, skills: readonly string[] = []) {
  const r = runtime(team.id);
  const existing = r.queue.find((q) => q.agentId === agentId);
  if (existing) {
    existing.msgIds.push(msgId);
    existing.returning = existing.returning && returning;
    existing.skills = [...new Set([...existing.skills, ...skills])];
  } else if (priority) r.queue.unshift({ agentId, msgIds: [msgId], returning, skills: [...skills] });
  else r.queue.push({ agentId, msgIds: [msgId], returning, skills: [...skills] });
  state(team);
  pump(team.id);
}

// Start a turn for every queued agent that isn't already working (one turn at a time per agent).
function pump(teamId: string) {
  const r = runtime(teamId);
  if (r.stopped) return;
  for (const item of [...r.queue]) {
    if (r.running.has(item.agentId)) continue;
    r.queue.splice(r.queue.indexOf(item), 1);
    const team = getTeam(teamId);
    if (!team || !team.members.includes(item.agentId)) continue;
    // budget: stop runaway back-and-forth
    const per = r.episode.per[item.agentId] || 0;
    if (r.episode.turns >= MAX_TURNS || per >= MAX_PER_AGENT) {
      r.queue = [];
      post(team, { from: 'system', text: `Paused: the team took ${r.episode.turns} turns on this. Reply to keep going, or mention someone to continue.` });
      state(team);
      return;
    }
    r.episode.turns++;
    r.episode.per[item.agentId] = per + 1;
    r.running.add(item.agentId);
    state(team);
    runTurn(team, item).finally(() => {
      r.running.delete(item.agentId);
      state(team);
      pump(teamId);
      settled(teamId);
    });
  }
}

function briefing(team: Team, agent: Agent): string {
  const roster = team.members
    .map((id) => agents.get(id))
    .filter((a): a is Agent => Boolean(a))
    .map((a) => `- @${a.name}${a.id === team.lead ? ' (lead)' : ''}${a.id === agent.id ? ' (you)' : ''}: ${a.specialty || a.description || ''}`)
    .join('\n');
  return `You are in the team chat "${team.name}".${team.description ? `\nTeam goal: ${team.description}` : ''}
Team members:
${roster}

How this chat works:
- Everyone sees the whole thread. Your reply is posted to the team as a message from you.
- To hand work to a teammate, mention them exactly as @Name and say precisely what you need back. Only mention someone who needs to act now; each stage should have one owner.
- Do your own part fully before handing off. Don't redo work a teammate owns.
- Anything that needs the user's judgment: ask them in your reply, without mentioning a teammate.
- The Brain (the project's overseer) hands the team work and checks on it. To ask it something (about the project, other teams, what to do next) or to say you're stuck, write @Brain.
- Keep replies short: what you did, the result, and who acts next.${team.lead === agent.id ? '\n- You are the lead: break the request down, give each part to one owner, and when everyone is done post the combined result for the user.' : ''}`;
}

async function runTurn(team: Team, item: QueueItem) {
  const agent = agents.get(item.agentId);
  if (!agent) return;
  const pid = activeProject().id;
  const epoch = runtime(team.id).epoch;
  const c = loadChat(team.id);
  // the agent's own memory of this team: one chat session per agent per team
  let chatId = c.sessions[agent.id];
  if (!chatId || !chats.get(agent.id, chatId)) {
    chatId = chats.create(agent.id, `Team: ${team.name}`, team.id).id;
    c.sessions[agent.id] = chatId;
  }
  const first = c.seen[agent.id] == null;
  const fresh = c.messages.slice(c.seen[agent.id] || 0).filter((m) => m.from !== agent.id);
  const name = (id: string) => (id === 'user' ? 'You (the user)' : id === 'system' ? 'System' : id === BRAIN ? 'The Brain (overseer)' : `@${agents.get(id)?.name || 'someone'}`);
  // files attached to a message: named in the line, their paths come at the end of the prompt
  const said = (m: TeamMessage) => `${name(m.from)}: ${String(m.text).slice(0, 2500)}${m.attachments?.length ? ` [attached: ${attachmentNames(m.attachments)}]` : ''}`;
  let digest = '';
  for (const m of fresh.slice().reverse()) {
    const line = said(m);
    if (digest.length + line.length > CONTEXT_CHARS) break;
    digest = `${line}\n\n${digest}`;
  }
  const forYou = c.messages.filter((m) => item.msgIds.includes(m.id)).map(said).join('\n\n');
  // the team's files go to the engine once per agent (so models that can't open files get them too), new ones when added;
  // plus what the user attached since this agent last read
  const given = new Set(c.filesSent?.[agent.id] || []);
  const newTeamFiles = (team.files || []).filter((f) => !given.has(f));
  const attachments = [...new Set([...newTeamFiles, ...[...fresh, ...c.messages.filter((m) => item.msgIds.includes(m.id))].flatMap((m) => m.attachments || [])])];
  c.seen[agent.id] = c.messages.length;
  c.filesSent = { ...c.filesSent, [agent.id]: team.files || [] };
  saveChat(team.id, c);
  const filesNote = newTeamFiles.length
    ? `The team's reference files from the user (${attachmentNames(newTeamFiles)}) are attached at the end.\n\n`
    : team.files?.length ? `The team's files: ${team.files.join(', ')}\n\n` : '';
  const prompt = `${first ? `${briefing(team, agent)}\n\n` : ''}${filesNote}New in the team chat since you last spoke:\n\n${digest.trim() || '(nothing new)'}\n\n---\nAddressed to you:\n${forYou}\n\nDo your part now, then reply to the team.`;
  // (where this turn starts in the agent's session: the team chat shows its work, live and afterwards)
  const from = chats.get(agent.id, chatId)?.items.length ?? 0;
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'start', chatId } });
  let text = '';
  let stopped = false;
  try {
    text = await askAgent(agent, prompt, { depth: 1, from: `team ${team.name}`, chatId, parentRunId: `team:${team.id}`, extra: { ...(team.access || {}), skills: [...new Set([...(team.skills || []), ...item.skills])] }, attachments });
  } catch (e) {
    // you stopped this agent's turn: say so in the thread, and hand nothing on
    stopped = e instanceof RunStopped;
    text = stopped ? '(stopped)' : `(I hit a problem: ${(e as Error).message})`;
  }
  const r = runtime(team.id);
  if (r.stopped || r.epoch !== epoch) {
    // stopped or cleared meanwhile: if cleared, don't let this turn bring the agent's session back
    if (loadChat(team.id, pid).sessions[agent.id] !== chatId) chats.remove(agent.id, chatId);
    return;
  }
  if (openProject().id !== pid) {
    // you switched projects while it worked: keep the reply in its own project, start nothing new there
    const back = loadChat(team.id, pid);
    const to = chats.get(agent.id, chatId)?.items.length ?? from;
    back.messages.push({ id: uid('m'), ts: Date.now(), from: agent.id, text: text || '(no answer)', mentions: [], ...(to > from ? { turn: { chatId, from, to } } : {}) });
    back.seen[agent.id] = back.messages.length;
    saveChat(team.id, back, pid);
    return;
  }
  const mentions = parseMentions(team, text, agent.id);
  const to = chats.get(agent.id, chatId)?.items.length ?? from;
  const msg = post(team, { from: agent.id, text: text || '(no answer)', mentions, ...(to > from ? { turn: { chatId, from, to } } : {}) });
  const c2 = loadChat(team.id);
  c2.seen[agent.id] = c2.messages.length;
  saveChat(team.id, c2);
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'end' } });
  if (stopped) return;
  for (const id of mentions) if (team.members.includes(id)) enqueue(team, id, msg.id, false, false, item.skills);
  // it asked the Brain: the Brain's answer comes back to it
  const askedBrain = mentionsBrain(text);
  if (askedBrain) void brainTurn(team, msg);
  // A handed-off job is done and nobody new is named: the answer goes back to the lead (or whoever asked), once.
  if (!mentions.length && !askedBrain && !item.returning && agent.id !== team.lead) {
    const asked = c.messages.filter((m) => item.msgIds.includes(m.id) && m.from !== 'user' && m.from !== 'system' && m.from !== BRAIN).map((m) => m.from);
    const back = team.lead && team.lead !== agent.id ? team.lead : asked.find((id) => id !== agent.id);
    if (asked.length && back && team.members.includes(back)) enqueue(team, back, msg.id, false, true, item.skills);
  }
}

// ---------- /queue: your messages that wait until the team is done ----------
const idle = (r: Runtime) => !r.running.size && !r.queue.length && !r.releasing;

/** Post now if nobody is working, else once the whole team is done (one held message at a time). */
export async function queueUserMessage(teamId: string, text: string | null | undefined, { replyTo = null, route = null, attachments = [] }: { replyTo?: string | null; route?: RouteFn | null; attachments?: string[] } = {}): Promise<{ message: TeamMessage } | { queued: QueuedMessage }> {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  text = String(text || '').trim();
  if (!text && !attachments.length) throw new Error('Write the message after /queue.');
  const r = runtime(team.id);
  if (idle(r) && !r.held.length) return { message: await postUserMessage(team.id, text, { replyTo, route, attachments }) };
  const queued: QueuedMessage = { id: uid('q'), text, ...(attachments.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}), ts: Date.now() };
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

// Nobody is working any more: post the next held message.
function releaseHeld(teamId: string) {
  const r = runtime(teamId);
  if (!r.held.length || !idle(r) || r.stopped) return;
  const team = getTeam(teamId);
  // (typed in another project: that project's thread isn't open now)
  if (!team || r.heldIn !== openProject().id) {
    r.held = [];
    if (team) state(team);
    return;
  }
  const next = r.held.shift()!;
  r.releasing = true;
  postUserMessage(team.id, next.text, { replyTo: next.replyTo || null, route: r.route, attachments: next.attachments || [] })
    .catch((e: unknown) => log('error', `${team.name}: a queued message couldn't be sent: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      r.releasing = false;
      state(team);
      releaseHeld(teamId);
    });
}

/** Take an agent off the turns it waits for in this project's teams (it was stopped, so it doesn't start
 *  on the next one as soon as its turn ends). Returns how many it had. */
export function dropQueuedTurns(agentId: string): number {
  let n = 0;
  for (const [teamId, r] of rt) {
    const team = getTeam(teamId);
    if (!team) continue; // another project's team
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
  const team = getTeam(teamId);
  const r = runtime(teamId);
  r.stopped = true;
  r.epoch++;
  r.queue = [];
  r.held = [];
  stopChildren(`team:${teamId}`);
  r.brainQueue = [];
  if (team) post(team, { from: 'system', text: 'Stopped. Nothing new will start until you write again.' });
  if (team) state(team);
  settled(teamId, true);
  return true;
}

export function clearThread(teamId: string) {
  if (!getTeam(teamId)) throw new Error('No such team.');
  // drop queued work and turns still running, so nothing late lands in the empty thread
  const r = runtime(teamId);
  r.epoch++;
  r.queue = [];
  r.held = [];
  r.episode = { turns: 0, per: {} };
  stopChildren(`team:${teamId}`);
  const c = loadChat(teamId);
  writeJSON(chatFile(teamId), { messages: [], sessions: {}, seen: {} });
  for (const [agentId, chatId] of Object.entries(c.sessions || {})) {
    forgetChat(chatId);
    chats.remove(agentId, chatId);
  }
  emit('team', { teamId, event: { kind: 'cleared' } });
}
