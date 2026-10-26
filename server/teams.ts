// Teams are group chats of agents. You write in the team chat; the lead (or the best member) answers,
// agents hand work to each other by @mentioning a teammate, and everyone sees one shared thread.
// Each agent keeps its own memory of the team (its own chat session), and gets the new messages each turn.
import { workflows as teamStore, agents, chats, emit, log, activeProject, openProject } from './store.ts';
import { readJSON, writeJSON, uid, dataPath } from './util.ts';
import { askAgent, stopChildren, forgetChat } from './engines/index.ts';
import { isStepList, teamSteps } from '../shared/teams.ts';
import type { Agent, Team, TeamMessage, TeamState } from '../shared/types.ts';

const MAX_TURNS = 16; // agent turns per message you send
const MAX_PER_AGENT = 5; // turns per agent per message you send
const CONTEXT_CHARS = 9000; // new group messages handed to an agent per turn
const KEEP_MESSAGES = 500;

/** The team chat file: the shared thread, each agent's own chat session, and how far each agent has read. */
interface TeamChat {
  messages: TeamMessage[];
  sessions: Record<string, string>; // agentId -> chatId
  seen: Record<string, number>; // agentId -> messages.length when it last read
}

/** A message before post() gives it an id and a time. */
interface NewMessage {
  from: string;
  text: string;
  mentions?: string[];
  replyTo?: string | null;
}

interface QueueItem {
  agentId: string;
  msgIds: string[];
  returning: boolean;
}

interface Runtime {
  queue: QueueItem[];
  running: Set<string>;
  episode: { turns: number; per: Record<string, number> };
  stopped?: boolean;
  epoch: number; // bumped by stop and clear: turns started before then are dropped
}

/** Picks the member who should answer when nobody is named and there is no lead (brain.pickMember). */
export type RouteFn = (text: string, members: (Agent | null)[]) => Promise<string | null | undefined>;

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
  if (!rt.has(teamId)) rt.set(teamId, { queue: [], running: new Set(), episode: { turns: 0, per: {} }, epoch: 0 });
  return rt.get(teamId)!;
}

export function teamState(teamId: string): TeamState {
  const r = runtime(teamId);
  return { working: [...r.running], queued: [...new Set(r.queue.map((q) => q.agentId))] };
}

export function getThread(teamId: string, limit = 200): TeamState & { messages: TeamMessage[] } {
  const c = loadChat(teamId);
  return { messages: c.messages.slice(-limit), ...teamState(teamId) };
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

// ---------- you write in the team chat ----------
export async function postUserMessage(teamId: string, text: string | null | undefined, { replyTo = null, route = null }: { replyTo?: string | null; route?: RouteFn | null } = {}): Promise<TeamMessage> {
  const team = getTeam(teamId);
  if (!team) throw new Error('No such team.');
  if (!team.members.length) throw new Error('This team has no agents yet. Add some first.');
  text = String(text || '').trim();
  if (!text) throw new Error('Write something first.');
  const mentions = parseMentions(team, text);
  const msg = post(team, { from: 'user', text, mentions, replyTo });
  const r = runtime(team.id);
  r.episode = { turns: 0, per: {} }; // a new message from you gives the team a fresh budget
  r.stopped = false;
  let targets = mentions;
  let why = '';
  if (!targets.length && replyTo) {
    const parent = loadChat(team.id).messages.find((m) => m.id === replyTo);
    if (parent && team.members.includes(parent.from)) targets = [parent.from];
  }
  if (!targets.length && team.lead) {
    targets = [team.lead];
    why = 'the lead';
  }
  if (!targets.length) {
    const pick = route ? await route(text, team.members.map((id) => agents.get(id))).catch(() => null) : null;
    targets = [pick && team.members.includes(pick) ? pick : team.members[0]];
    why = pick ? 'best fit' : 'first member';
  }
  for (const id of targets) enqueue(team, id, msg.id, true);
  if (why) emit('team', { teamId: team.id, event: { kind: 'routed', to: targets, why } });
  log('team', `You → ${team.name}: ${text.slice(0, 100)}`);
  return msg;
}

// returning: this is a finished handoff coming back (the receiver's own reply won't bounce back again)
function enqueue(team: Team, agentId: string, msgId: string, priority = false, returning = false) {
  const r = runtime(team.id);
  const existing = r.queue.find((q) => q.agentId === agentId);
  if (existing) {
    existing.msgIds.push(msgId);
    existing.returning = existing.returning && returning;
  } else if (priority) r.queue.unshift({ agentId, msgIds: [msgId], returning });
  else r.queue.push({ agentId, msgIds: [msgId], returning });
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
  const name = (id: string) => (id === 'user' ? 'You (the user)' : id === 'system' ? 'System' : `@${agents.get(id)?.name || 'someone'}`);
  let digest = '';
  for (const m of fresh.slice().reverse()) {
    const line = `${name(m.from)}: ${String(m.text).slice(0, 2500)}`;
    if (digest.length + line.length > CONTEXT_CHARS) break;
    digest = `${line}\n\n${digest}`;
  }
  const forYou = c.messages.filter((m) => item.msgIds.includes(m.id)).map((m) => `${name(m.from)}: ${String(m.text).slice(0, 2500)}`).join('\n\n');
  c.seen[agent.id] = c.messages.length;
  saveChat(team.id, c);
  const prompt = `${first ? `${briefing(team, agent)}\n\n` : ''}New in the team chat since you last spoke:\n\n${digest.trim() || '(nothing new)'}\n\n---\nAddressed to you:\n${forYou}\n\nDo your part now, then reply to the team.`;
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'start' } });
  let text = '';
  try {
    text = await askAgent(agent, prompt, { depth: 1, from: `team ${team.name}`, chatId, parentRunId: `team:${team.id}`, extra: { ...(team.access || {}), skills: team.skills || [] } });
  } catch (e) {
    text = `(I hit a problem: ${(e as Error).message})`;
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
    back.messages.push({ id: uid('m'), ts: Date.now(), from: agent.id, text: text || '(no answer)', mentions: [] });
    back.seen[agent.id] = back.messages.length;
    saveChat(team.id, back, pid);
    return;
  }
  const mentions = parseMentions(team, text, agent.id);
  const msg = post(team, { from: agent.id, text: text || '(no answer)', mentions });
  const c2 = loadChat(team.id);
  c2.seen[agent.id] = c2.messages.length;
  saveChat(team.id, c2);
  emit('team', { teamId: team.id, event: { kind: 'turn', agentId: agent.id, state: 'end' } });
  for (const id of mentions) if (team.members.includes(id)) enqueue(team, id, msg.id, false);
  // A handed-off job is done and nobody new is named: the answer goes back to the lead (or whoever asked), once.
  if (!mentions.length && !item.returning && agent.id !== team.lead) {
    const asked = c.messages.filter((m) => item.msgIds.includes(m.id) && m.from !== 'user' && m.from !== 'system').map((m) => m.from);
    const back = team.lead && team.lead !== agent.id ? team.lead : asked.find((id) => id !== agent.id);
    if (asked.length && back && team.members.includes(back)) enqueue(team, back, msg.id, false, true);
  }
}

export function stopTeam(teamId: string) {
  const team = getTeam(teamId);
  const r = runtime(teamId);
  r.stopped = true;
  r.epoch++;
  r.queue = [];
  stopChildren(`team:${teamId}`);
  if (team) post(team, { from: 'system', text: 'Stopped. Nothing new will start until you write again.' });
  if (team) state(team);
  return true;
}

export function clearThread(teamId: string) {
  if (!getTeam(teamId)) throw new Error('No such team.');
  // drop queued work and turns still running, so nothing late lands in the empty thread
  const r = runtime(teamId);
  r.epoch++;
  r.queue = [];
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
