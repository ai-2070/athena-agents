// The agents' routes (shared/api/agents.ts).
import { implement } from '@orpc/server';
import { agents as contract } from '../../shared/api/agents.ts';
import * as store from '../store.ts';
import { agents, workflows, log } from '../store.ts';
import * as engines from '../engines/index.ts';
import * as tools from '../tools.ts';
import * as programs from '../programs.ts';
import * as library from '../library.ts';
import * as commands from '../commands.ts';
import * as kb from '../knowledge.ts';
import * as teams from '../teams.ts';
import { exists, openWithShell } from '../util.ts';
import { refuse } from './refuse.ts';
import type { Agent } from '../../shared/types.ts';

const os = implement(contract);

const agentOf = (id: string): Agent => agents.get(id) || refuse('That agent is unavailable.', 404);

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
    remove: os.knowledge.remove.handler(({ input: { id, folder, label } }) => {
      const a = agentOf(id);
      if (folder) agents.save({ ...a, knowledge: { folders: (a.knowledge?.folders || []).filter((f) => f !== folder) } });
      else if (label) kb.removeKnowledgeFile(id, label);
      else return refuse('Say which file or folder to remove.');
      return { ok: true as const };
    }),
  },
});
