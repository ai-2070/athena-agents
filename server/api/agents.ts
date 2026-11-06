// The agents' routes (shared/api/agents.ts).
import { implement, streamToEventIterator } from '@orpc/server';
import { agents as contract } from '../../shared/api/agents.ts';
import * as store from '../store.ts';
import { agents, chats, workflows, log } from '../store.ts';
import { clearWork, openGoal } from '../briefs.ts';
import { cleanAttachments } from '../uploads.ts';
import { queuedText } from '../../shared/queue.ts';
import * as engines from '../engines/index.ts';
import * as tools from '../tools.ts';
import * as programs from '../programs.ts';
import * as library from '../library.ts';
import * as commands from '../commands.ts';
import * as kb from '../knowledge.ts';
import * as teams from '../teams.ts';
import { streamRun } from '../uistream.ts';
import { exists, openWithShell } from '../util.ts';
import { refuse } from './refuse.ts';
import type { Agent, Chat } from '../../shared/types.ts';

const os = implement(contract);

const agentOf = (id: string): Agent => agents.get(id) || refuse('That agent is unavailable.', 404);
const chatOf = (id: string, chatId: string): Chat => chats.get(id, chatId) || refuse('That chat is unavailable.', 404);
// what was typed, and the files attached (only uploads of the project count)
const said = (input: { text?: string; attachments?: string[] }) => ({ text: (input.text || '').trim(), attachments: cleanAttachments(input.attachments) });

/** /queue: a message that goes once the agent is done in this chat (now, if it isn't working). */
function queueIn(a: Agent, c: Chat, text: string, attachments: string[]) {
  if (!text && !attachments.length) return refuse('Write the message after /queue.');
  return engines.queueMessage(a, c, text, attachments);
}

/** Deletes an agent: its sessions end, and it comes off every team it was on. */
export function deleteAgent(gone: Agent): void {
  const id = gone.id;
  engines.retireAgentSessions(id);
  agents.remove(id);
  log('agent', `Deleted agent ${gone.name}`, { agentId: id });
  for (const wf of workflows.list()) {
    const steps = (wf.steps || []).filter((s) => !(s.type === 'agent' && s.agentId === id));
    const members = teams.normalize({ ...wf }).members; // without the deleted agent (old step lists too)
    if (steps.length !== (wf.steps || []).length || members.length !== (wf.members || []).length) workflows.save({ ...wf, steps, members, lead: wf.lead === id ? null : wf.lead });
  }
}

// A page's text, from a link: the HTML's tags and scripts taken out.
const pageText = (text: string, type: string) =>
  /html/.test(type) ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ') : text;

export const agentsRouter = os.router({
  list: os.list.handler(() => agents.list()),
  create: os.create.handler(({ input }) => library.newAgent(input)),
  get: os.get.handler(({ input }) => {
    const a = agentOf(input.id);
    return { ...a, knowledgeFiles: kb.knowledgeFiles(a).map(({ label, size, own }) => ({ label, size, own })), workspacePath: tools.workspaceOf(a), tools: tools.toolsForAgent(a).map((t) => t.name) };
  }),
  change: os.change.handler(({ input: { id, ...patch } }) => {
    const a = agentOf(id);
    if (patch.engine && patch.engine !== a.engine) engines.retireAgentSessions(id);
    return agents.save({ ...a, ...patch });
  }),
  remove: os.remove.handler(({ input }) => {
    deleteAgent(agentOf(input.id));
    return { ok: true as const };
  }),
  duplicate: os.duplicate.handler(({ input }) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = agentOf(input.id);
    return library.newAgent({ ...rest, name: `${rest.name} (copy)` });
  }),
  exportClaude: os.exportClaude.handler(({ input }) => ({ file: library.exportToClaude(agentOf(input.id)) })),
  openWorkspace: os.openWorkspace.handler(async ({ input }) => {
    const dir = tools.workspaceOf(agentOf(input.id));
    if (input.app === 'vscode') return { message: await programs.launchProgram('vscode', { file: dir }) };
    openWithShell(dir);
    return { ok: true as const };
  }),
  commands: os.commands.handler(({ input }) => commands.harnessCommands(agentOf(input.id).id)),
  chats: {
    // (the run is listened to from the moment it starts, so nothing it says is missed)
    stream: os.chats.stream.handler(async ({ input }) => {
      const a = agentOf(input.id);
      const c = chatOf(input.id, input.chatId);
      const { text, attachments } = said(input);
      if (!text && !attachments.length) return refuse('Type a message first.');
      const { runId, steerId } = input.steer === true ? await engines.steerChat(a, c, text, { attachments }) : { ...engines.startRun(a, c, text, { attachments }), steerId: undefined };
      return streamToEventIterator(streamRun({ chatId: c.id, runId, waiting: `Waiting for ${a.name} to stop…`, ...(steerId ? { ownSteer: steerId } : {}), live: engines.runActive }));
    }),
    reconnect: os.chats.reconnect.handler(({ input: { id, chatId } }) => {
      const runId = engines.chatRunId(id, chatId);
      return runId ? streamToEventIterator(streamRun({ chatId, runId, items: engines.liveChat(chatId)?.items || [] })) : null;
    }),
    list: os.chats.list.handler(({ input }) => chats.list(input.id)),
    create: os.chats.create.handler(({ input }) => chats.create(agentOf(input.id).id)),
    get: os.chats.get.handler(({ input: { id, chatId } }) => ({ ...chatOf(id, chatId), queued: engines.queuedMessages(chatId), loop: engines.loopOf(chatId), goal: openGoal('agent', id, chatId) })),
    remove: os.chats.remove.handler(({ input: { id, chatId } }) => {
      engines.forgetChat(chatId);
      clearWork('agent', id, chatId);
      chats.remove(id, chatId);
      return { ok: true as const };
    }),
    change: os.chats.change.handler(({ input: { id, chatId, title, reset } }) => {
      // While a run is going, change the copy it is writing so the edit sticks.
      const c = engines.liveChat(chatId) || chatOf(id, chatId);
      if (title) c.title = title.slice(0, 120);
      if (reset) engines.resetMemory(c);
      return chats.save(c);
    }),
    send: os.chats.send.handler(({ input }) => {
      const a = agentOf(input.id);
      const c = chatOf(input.id, input.chatId);
      const { text, attachments } = said(input);
      if (!text && !attachments.length) return refuse('Type a message first.');
      // "/queue …" waits until the agent is done here (or goes now)
      const queued = queuedText(text);
      if (queued != null) return queueIn(a, c, queued, attachments);
      return { runId: engines.startRun(a, c, text, { attachments }).runId };
    }),
    queue: os.chats.queue.handler(({ input }) => {
      const { text, attachments } = said(input);
      return queueIn(agentOf(input.id), chatOf(input.id, input.chatId), text, attachments);
    }),
    unqueue: os.chats.unqueue.handler(({ input }) => ({ unqueued: engines.unqueue(input.chatId, input.queueId) })),
    editQueued: os.chats.editQueued.handler(({ input }) => ({ queued: engines.editQueued(input.chatId, input.queueId, input.text) })),
    orderQueue: os.chats.orderQueue.handler(({ input }) => ({ queued: engines.orderQueued(input.chatId, input.ids) })),
    resend: os.chats.resend.handler(({ input }) => commands.resendInChat(input.id, input.chatId)),
    resume: os.chats.resume.handler(({ input }) => commands.resumeInChat(input.id, input.chatId)),
    loop: os.chats.loop.handler(({ input }) => commands.loopInChat(input.id, input.chatId, input.text ?? '', cleanAttachments(input.attachments))),
    stopLoop: os.chats.stopLoop.handler(({ input }) => ({ ok: engines.stopLoop(input.chatId, 'Loop stopped.') })),
    learn: os.chats.learn.handler(({ input }) => {
      const { text, attachments } = said(input);
      return commands.learnInChat(input.id, input.chatId, text.slice(0, 4000), attachments);
    }),
    goal: os.chats.goal.handler(({ input }) => commands.goalInChat(input.id, input.chatId, input.text.trim().slice(0, 4000))),
    clearGoal: os.chats.clearGoal.handler(({ input }) => commands.goalInChat(input.id, input.chatId, 'clear')),
    memory: os.chats.memory.handler(({ input }) => engines.memoryOf(agentOf(input.id), input.chatId)),
    stop: os.chats.stop.handler(({ input: { chatId } }) => {
      // the /queue messages come back to you (they'd otherwise start as soon as it stopped); a loop ends
      const unqueued = engines.unqueue(chatId);
      engines.stopLoop(chatId, 'Loop stopped.');
      engines.stopChat(chatId);
      return { ok: true as const, unqueued };
    }),
  },
  knowledge: {
    add: os.knowledge.add.handler(async ({ input: { id, folder, url, name, content } }) => {
      const a = agentOf(id);
      if (folder) {
        if (!exists(folder)) return refuse(`${folder} does not exist.`);
        agents.save({ ...a, knowledge: { folders: [...new Set([...(a.knowledge?.folders || []), folder])] } });
        return { ok: true as const };
      }
      if (url) {
        // (the download takes a while: the file goes to this project's agent, whichever project is open by then)
        return store.withProject(store.activeProject(), async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const text = await res.text();
          const file = name || new URL(url).hostname + new URL(url).pathname.replace(/\W+/g, '_') + '.md';
          return { file: kb.addKnowledgeFile(id, file, `Source: ${url}\n\n${pageText(text, res.headers.get('content-type') || '')}`) };
        });
      }
      return { file: kb.addKnowledgeFile(id, name, content || '') };
    }),
    remove: os.knowledge.remove.handler(({ input: { params: { id }, query: { folder, label } } }) => {
      const a = agentOf(id);
      if (folder) agents.save({ ...a, knowledge: { folders: (a.knowledge?.folders || []).filter((f) => f !== folder) } });
      else if (label) kb.removeKnowledgeFile(id, label);
      else return refuse('Say which file or folder to remove.');
      return { ok: true as const };
    }),
  },
});
