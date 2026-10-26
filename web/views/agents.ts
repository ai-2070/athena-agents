// Agents: your team, and the editor for one agent.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, refreshSoon, avatar, engineBadge, navigate, seg, chipSet, field, select, toast, confirmBox, promptBox, onState, isRunning, copy, ago, toggleRow } from '../core.ts';
import { skillPicker } from '../skillpick.ts';
import { historyButton, deletedButton } from '../history.ts';
import { memoryEditor } from '../memory.ts';
import type { Option } from '../core.ts';
import type { ModelListing } from '../models.ts';
import { EFFORT_NAMES, effortFor, effortLevels } from '../../shared/effort.ts';
import type { Agent, Autonomy, EngineStatus, Team, Terminal } from '../../shared/types.ts';

/** GET /api/agents/:id: the agent plus its knowledge files and resolved workspace. */
export interface AgentDetail extends Agent {
  knowledgeFiles: { label: string; size: number; own: boolean }[];
  workspacePath: string;
  tools: string[];
}
/** One entry of GET /api/openclaw/agents. */
interface OpenClawAgent {
  id: string;
  model: string;
  isDefault: boolean;
}
/** One entry of GET /api/hermes/profiles. */
interface HermesProfile {
  name: string;
  model: string;
  gateway: string;
  isDefault: boolean;
}
/** The part of GET /api/mcp used here. */
interface McpListing {
  servers: Record<string, unknown>;
}

let root: HTMLElement | undefined;
let off: (() => void) | null | undefined;

export const title = (params: string[] = []): string => (params[1] === 'edit' ? 'Edit agent' : 'Agents');

export async function render(el: HTMLElement, params: string[] = []): Promise<void> {
  root = el;
  if (params[0] && params[1] === 'edit') return renderEditor(el, params[0]);
  off = onState(drawList);
  drawList();
}

export function unmount(): void {
  off?.();
  off = null;
  listGrid = null;
  window.onbeforeunload = null;
}

let filter = '';
let listGrid: HTMLDivElement | null = null;
let fillList: (() => void) | null = null;

// The search box is built once; live updates only refill the cards so typing isn't interrupted.
function drawList(): void {
  const d = state.data;
  if (!d || !root) return;
  if (listGrid && root.contains(listGrid)) return fillList!();
  const grid = h('div.cards');
  listGrid = grid;
  const fill = () => {
    const agents = state.data!.agents;
    const q = filter.toLowerCase();
    mount(
      grid,
      agents
        .filter((a) => !q || `${a.name} ${a.specialty} ${a.description}`.toLowerCase().includes(q))
        .map((a) =>
          h(
            'div.card',
            h('div.card-top', avatar(a, true), h('div.grow', h('div.card-title', a.name), h('div.card-sub', a.specialty || a.description || 'No specialty yet'))),
            isRunning(a.id) ? h('span.corner.pill.warn', h('span.dot.busy'), 'working') : a.pinned ? h('span.corner.faint', '★') : null,
            h('div.row', { style: { gap: '6px' } }, engineBadge(a), h('span.pill', a.autonomy === 'full' ? 'full autonomy' : a.autonomy === 'ask' ? 'asks first' : 'auto')),
            h(
              'div.card-foot',
              h('button.btn.small', { onclick: () => navigate(`#/agents/${a.id}`) }, 'Chat'),
              h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${a.id}/edit`) }, 'Edit'),
              a.engine !== 'openai' ? h('button.btn.ghost.small', { onclick: () => openTerminal(a) }, 'Terminal') : null,
            ),
          ),
        ),
    );
    if (!grid.children.length) grid.append(h('div.empty.box', agents.length ? 'No agent matches.' : 'No agents yet. Create one, or hire from the Library.'));
  };
  fillList = fill;
  const search = h('input', { placeholder: 'Search agents', value: filter, oninput: (e) => ((filter = e.target.value), fill()) });
  mount(
    root,
    h(
      'div.row.between',
      { style: { marginBottom: '16px' } },
      h('div', { style: { width: 'min(360px, 100%)' } }, search),
      h('div.row', deletedButton(['agent', 'team'], () => refreshSoon(0)), h('a.btn.ghost', { href: '#/library' }, 'Hire from library'), h('button.btn', { onclick: createAgent }, '+ New agent')),
    ),
    grid,
  );
  fill();
}

async function createAgent(): Promise<void> {
  const a = await attempt(() => POST<Agent>('/agents', { name: 'New agent' }));
  if (a) navigate(`#/agents/${a.id}/edit`);
}

export async function openTerminal(agent: Pick<Agent, 'id'>): Promise<void> {
  const t = await attempt(() => POST<Terminal>('/terminals', { kind: 'agent', agentId: agent.id }));
  if (t) navigate(`#/terminals/${t.id}`);
}

// ---------- editor ----------
const AUTONOMY: Option<Autonomy>[] = [
  { value: 'ask', label: 'Ask first', title: 'You approve every action that changes something' },
  { value: 'auto', label: 'Auto', title: 'Runs on its own; asks only for risky things (running code, shell, messages)' },
  { value: 'full', label: 'Full', title: 'Never asks. Only for agents you trust completely' },
];

async function renderEditor(el: HTMLElement, id: string): Promise<void> {
  const [agent, mcpData, profiles, teams, clawAgents] = await Promise.all([
    GET<AgentDetail>(`/agents/${id}`),
    GET<McpListing>('/mcp'),
    GET<HermesProfile[]>('/hermes/profiles').catch((): HermesProfile[] => []),
    GET<Team[]>('/workflows').catch((): Team[] => []),
    GET<OpenClawAgent[]>('/openclaw/agents').catch((): OpenClawAgent[] => []),
  ]);
  const d = state.data!;
  const a: Agent = structuredClone(agent);
  let dirty = false;
  const mark = () => {
    dirty = true;
    saveBtn.disabled = false;
  };
  const set = <K extends keyof Agent>(k: K) => (v: Agent[K]) => {
    a[k] = v;
    mark();
  };

  const saveBtn = h('button.btn', { disabled: true, onclick: () => save() }, 'Save');
  const save = async (thenChat = false) => {
    const r = await attempt(() => PUT(`/agents/${id}`, a), 'Saved');
    if (r) {
      dirty = false;
      saveBtn.disabled = true;
      if (thenChat) navigate(`#/agents/${id}`);
    }
  };

  // A new engine or provider may not have the effort level: save the nearest one it has, the one the Effort field shows.
  const fitEffort = () => {
    if (a.effort) a.effort = effortFor(a.engine, a.effort, a.provider);
  };

  // engine-dependent section
  const engineBox = h('div.col');
  const modelList = h('datalist#models');
  const loadModels = async () => {
    clear(modelList);
    const q = a.engine === 'openai' ? `engine=openai&provider=${a.provider}` : `engine=${a.engine}`;
    const models = await GET<ModelListing[]>(`/models?${q}`).catch((): ModelListing[] => []);
    for (const m of models.slice(0, 600)) modelList.append(h('option', { value: m.id }, `${m.name}${m.price ? ` · $${m.price.in.toFixed(2)}/$${m.price.out.toFixed(2)} per M` : ''}${m.tools === false ? ' · no tools' : ''}`));
  };
  const drawEngine = () => {
    const modelInput = h('input', { value: a.model || '', list: 'models', placeholder: a.engine === 'claude-code' ? 'sonnet' : a.engine === 'hermes' ? "profile's default" : a.engine === 'openclaw' ? "the OpenClaw agent's model" : a.engine === 'pi' || a.engine === 'omp' ? 'its default (e.g. anthropic/claude-sonnet-5-5)' : 'anthropic/claude-sonnet-5.5', oninput: (e) => set('model')(e.target.value.trim()) });
    const parts: HTMLElement[] = [];
    if (a.engine === 'claude-code') {
      parts.push(
        h(
          'div.grid-2',
          field('Model', modelInput, 'sonnet, opus, haiku, fable, or a full model id.'),
          field(
            'Sign in with',
            select(
              [
                { value: 'login', label: 'My Claude login (subscription)' },
                { value: 'anthropic', label: `Anthropic API key${d.secrets.anthropicKey.set ? '' : ' (not set)'}` },
                { value: 'openrouter', label: `OpenRouter key${d.secrets.openrouterKey.set ? '' : ' (not set)'}` },
              ],
              a.claudeAuth || 'login',
              set('claudeAuth'),
            ),
            'With OpenRouter, use OpenRouter model ids like anthropic/claude-sonnet-5.5.',
          ),
        ),
      );
    } else if (a.engine === 'openai') {
      parts.push(
        h(
          'div.grid-2',
          field(
            'Provider',
            select(
              [
                { value: 'openrouter', label: `OpenRouter${d.secrets.openrouterKey.set ? '' : ' (add key in Settings)'}` },
                { value: 'lmstudio', label: 'LM Studio (local)' },
                { value: 'ollama', label: 'Ollama (local)' },
                { value: 'custom', label: 'Custom OpenAI-compatible' },
              ],
              a.provider || 'openrouter',
              (v) => {
                set('provider')(v);
                fitEffort(); // a server on this PC takes fewer effort levels
                drawEngine();
              },
            ),
          ),
          field('Model', modelInput, 'Start typing to search. Pick one that supports tools.'),
        ),
        field('Temperature', h('input', { type: 'number', step: '0.1', min: '0', max: '2', value: a.temperature ?? '', placeholder: 'model default', oninput: (e) => set('temperature')(e.target.value as Agent['temperature']) })),
      );
    } else if (a.engine === 'codex') {
      const cx: Partial<EngineStatus['codex']> = d.engines.codex || {};
      parts.push(
        h('div.grid-2', field('Model', modelInput, "Empty = Codex's default (e.g. gpt-6-astra)."), h('div', h('div.label', 'Codex'), h('p.hint', cx.installed ? (cx.loggedIn ? `Signed in · ${cx.version || ''}` : 'Installed, not signed in yet: Settings > General > Sign in') : 'Not installed yet: Settings > General > Install Codex'))),
        h('p.hint', 'Codex runs in the workspace folder. Autonomy maps to its sandbox: Ask first = read-only, Auto = can edit the workspace, Full = no sandbox.'),
      );
    } else if (a.engine === 'hermes') {
      parts.push(
        h(
          'div.grid-2',
          field('Hermes profile', select([{ value: '', label: 'default' }, ...profiles.filter((p) => p.name !== 'default').map((p) => ({ value: p.name, label: `${p.name} (${p.model})` }))], a.hermesProfile || '', set('hermesProfile')), 'The profile brings its own memory, skills and tools.'),
          field('Model override', modelInput, "Leave empty to use the profile's model."),
        ),
        h('p.hint', 'Hermes uses its own tools. To give it the dashboard tools too, use "Give Hermes the dashboard tools" on the Tools & MCP page.'),
      );
    } else if (a.engine === 'pi' || a.engine === 'omp') {
      const name = a.engine === 'pi' ? 'pi' : 'oh-my-pi';
      const st: Partial<EngineStatus['pi']> = d.engines[a.engine] || {};
      parts.push(
        h('div.grid-2', field('Model', modelInput, `Empty = ${name}'s default. Ids are provider/model, e.g. anthropic/claude-sonnet-5-5.`), h('div', h('div.label', name), h('p.hint', st.installed ? `Found${st.version ? ` · ${st.version}` : ''}` : `Not installed yet: ${a.engine === 'pi' ? 'npm install -g @earendil-works/pi-coding-agent' : 'bun install -g @oh-my-pi/pi-coding-agent'}`))),
        h('p.hint', `${name} works in the workspace folder with its own tools (read, bash, edit, write…) and runs them without asking, whatever the autonomy below says. Sign it in to a model provider in a terminal (/login). For the dashboard tools too, use "Give pi and oh-my-pi the dashboard tools" on the Tools & MCP page.`),
      );
    } else if (a.engine === 'openclaw') {
      parts.push(
        h(
          'div.grid-2',
          field('OpenClaw agent', select([{ value: '', label: 'its default agent' }, ...clawAgents.map((x) => ({ value: x.id, label: `${x.id}${x.model ? ` (${x.model})` : ''}${x.isDefault ? ' · default' : ''}` }))], a.openclawAgent || '', set('openclawAgent')), 'It brings its own memory, skills and tools.'),
          field('Model override', modelInput, "Leave empty to use the OpenClaw agent's model."),
        ),
        h('p.hint', "Each chat here is its own OpenClaw session. It goes through your OpenClaw Gateway when it is running, else OpenClaw answers here on its own. OpenClaw's own approval settings apply to its tools."),
      );
    }
    parts.push(
      field(
        'Effort',
        select([{ value: '', label: "Model's default" }, ...effortLevels(a.engine, a.provider).map((e) => ({ value: e, label: EFFORT_NAMES[e] }))], effortFor(a.engine, a.effort, a.provider), (v) => set('effort')(v as Agent['effort'])),
        'How hard the model thinks before it answers. More effort: better on hard work, but slower and uses more of your plan.',
      ),
    );
    mount(engineBox, parts);
    loadModels();
  };

  // knowledge
  const kbBox = h('div.col');
  const drawKnowledge = async () => {
    const fresh = await GET<AgentDetail>(`/agents/${id}`);
    a.knowledge = fresh.knowledge;
    const files = fresh.knowledgeFiles;
    const total = files.reduce((n, f) => n + f.size, 0);
    mount(
      kbBox,
      h('p.hint', total <= 24000 ? 'Small knowledge is given to the agent in full with every message.' : 'Large knowledge: the agent searches it when needed (knowledge_search).', ` ${files.length} file${files.length === 1 ? '' : 's'} · ${Math.round(total / 1024)} KB`),
      (a.knowledge?.folders || []).map((f) =>
        h('div.list-item', h('span', '📁'), h('div.grow.mono', { style: { fontSize: '12.5px', overflowWrap: 'anywhere' } }, f), h('button.btn.tiny.ghost', { onclick: () => attempt(() => DEL(`/agents/${id}/knowledge?folder=${encodeURIComponent(f)}`)).then(drawKnowledge) }, 'Unlink')),
      ),
      files
        .filter((f) => f.own)
        .map((f) =>
          h('div.list-item', h('span', '📄'), h('div.grow', f.label, h('span.hint', ` · ${Math.max(1, Math.round(f.size / 1024))} KB`)), h('button.btn.tiny.ghost', { onclick: () => attempt(() => DEL(`/agents/${id}/knowledge?label=${encodeURIComponent(f.label)}`)).then(drawKnowledge) }, 'Remove')),
        ),
      h(
        'div.row',
        h('button.btn.ghost.small', { onclick: () => addNote() }, '+ Write a note'),
        h('label.btn.ghost.small', { style: { cursor: 'pointer' } }, '+ Upload files', h('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: (e) => upload(e.target.files!) })),
        h('button.btn.ghost.small', { onclick: () => addFolder() }, '+ Link a folder'),
        h('button.btn.ghost.small', { onclick: () => addUrl() }, '+ From a web page'),
      ),
    );
  };
  const addNote = async () => {
    const name = await promptBox('Note name', { value: 'notes.md' });
    if (!name) return;
    const content = await promptBox(name, { multiline: true, placeholder: 'Facts, style guides, product details, anything this agent should know.' });
    if (content == null) return;
    await attempt(() => POST(`/agents/${id}/knowledge`, { name, content }), 'Added');
    drawKnowledge();
  };
  const upload = async (files: FileList) => {
    for (const f of files) {
      if (f.size > 5_000_000) {
        toast(`${f.name} is over 5 MB; link its folder instead.`, 'warn');
        continue;
      }
      const content = await f.text();
      await attempt(() => POST(`/agents/${id}/knowledge`, { name: f.name, content }));
    }
    toast('Uploaded');
    drawKnowledge();
  };
  const addFolder = async () => {
    const folder = await promptBox('Link a folder or file', { label: 'Full path on this PC (the agent reads text files inside it)', placeholder: 'C:\\Users\\you\\Documents\\brand' });
    if (!folder) return;
    await attempt(() => POST(`/agents/${id}/knowledge`, { folder: folder.trim().replace(/^"|"$/g, '') }), 'Linked');
    drawKnowledge();
  };
  const addUrl = async () => {
    const url = await promptBox('Save a web page as knowledge', { placeholder: 'https://…' });
    if (!url) return;
    await attempt(() => POST(`/agents/${id}/knowledge`, { url: url.trim() }), 'Saved');
    drawKnowledge();
  };

  // (saved by its own Save button: the agent may write to it while you edit the rest)
  const memory = memoryEditor(id, { rows: 10 });
  const servers = Object.keys(mcpData.servers);
  const emoji = h('input', { value: a.emoji, style: { width: '64px', textAlign: 'center', fontSize: '20px' }, oninput: (e) => set('emoji')(e.target.value) });
  const color = h('input', { type: 'color', value: a.color || '#c4ff3d', style: { width: '44px', height: '38px', padding: '2px', background: 'var(--panel)', border: '1px solid var(--line-2)' }, oninput: (e) => set('color')(e.target.value) });

  mount(
    el,
    h(
      'div.row.between',
      { style: { marginBottom: '16px' } },
      h('a.btn.ghost.small', { href: '#/agents' }, '← Agents'),
      h('div.row', h('button.btn.ghost', { onclick: async () => (dirty ? save(true) : navigate(`#/agents/${id}`)) }, 'Chat'), saveBtn),
    ),
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Who it is')),
          h('div.row.nowrap', { style: { alignItems: 'flex-end' } }, field('Icon', emoji), field('Color', color), h('div.grow', field('Name', h('input', { value: a.name, oninput: (e) => set('name')(e.target.value) })))),
          h('div.mt', field('Specialty', h('input', { value: a.specialty, placeholder: 'e.g. writes punchy X threads about AI', oninput: (e) => set('specialty')(e.target.value) }), 'One line. Other agents see it when deciding who to ask.')),
          h(
            'div.mt',
            field(
              'Instructions',
              h('textarea.code', { rows: 16, value: a.systemPrompt, placeholder: 'How this agent thinks, works and talks. Its process, rules, what good output looks like.', oninput: (e) => set('systemPrompt')(e.target.value) }),
            ),
          ),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Knowledge')), kbBox),
        h('div.panel', h('div.panel-head', h('h2', 'MEMORY.md'), h('span.hint', 'saved on its own')), memory.el),
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Brain')),
          seg(
            d.engineList.map((e) => ({ value: e.id, label: e.label, title: e.description })),
            a.engine,
            (v) => {
              a.engine = v;
              a.model = v === 'claude-code' ? d.settings.defaults.claudeModel : v === 'openai' ? d.settings.defaults.openrouterModel : '';
              fitEffort();
              mark();
              drawEngine();
            },
          ),
          h('p.hint.mt', d.engineList.find((e) => e.id === a.engine)?.description || ''),
          h('div.mt', engineBox),
          modelList,
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Autonomy')),
          seg(AUTONOMY, a.autonomy || 'auto', set('autonomy')),
          h('p.hint.mt', 'Ask first: you approve anything that changes something. Auto: asks only for risky actions (running code or scripts in Blender, Photoshop, After Effects, ffmpeg, shell, sending messages); click Always allow to stop being asked for a tool. Full: never asks. X posts always wait in the Outbox unless you turn on auto-post for that account.'),
          a.alwaysAllow?.length
            ? h('div.mt', h('div.label', 'Always allowed'), h('div.row.mt', { style: { gap: '6px' } }, a.alwaysAllow.map((t) => h('span.pill', t))), h('button.btn.tiny.ghost.mt', { onclick: () => (set('alwaysAllow')([]), toast('Cleared; save to apply')) }, 'Clear'))
            : null,
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Answers')),
          toggleRow(!!a.richAnswers, (on) => set('richAnswers')(on), 'Rich answers'),
          h('p.hint.mt', 'In your own chats with this agent it answers with live components (cards, tables, charts, forms with buttons) instead of plain text. Good for research, comparisons, reports and plans. Off for coding agents and team chats: it adds about 13k tokens of instructions to every message, and smaller or local models often get it wrong. Team chats, routines and other agents always get plain text.'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Tools')),
          chipSet(
            d.toolGroups.map((g) => ({ value: g.id, label: g.label, title: g.description })),
            a.toolGroups,
            set('toolGroups'),
          ),
          h('p.hint.mt', 'Hover a tool for what it does. Claude Code and Hermes agents also keep their own built-in tools.'),
          h('div.label.mt-lg', 'MCP servers'),
          servers.length ? h('div.mt', chipSet(servers, a.mcpServers, set('mcpServers'))) : h('p.hint.mt', h('span', 'No MCP servers yet. '), h('a', { href: '#/settings?tab=mcp' }, 'Add one'), ' (browser control, GitHub, Blender live…).'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Skills')),
          skillPicker(a.skills || [], set('skills'), {
            inherited: [
              ...(d.project?.skills || []).map((slug) => ({ slug, from: 'project' })),
              ...teams.filter((w) => (w.members || []).includes(id)).flatMap((w) => (w.skills || []).map((slug) => ({ slug, from: w.name }))),
            ],
            empty: 'No skills of its own yet.',
          }),
          h('p.hint.mt', 'Skills given to this agent. It also gets the project\'s skills and, while working for a team, that team\'s skills (both greyed). Save to apply. Manage the library under Skills.'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Workspace')),
          field('Working folder', h('input', { value: a.workspace || '', placeholder: agent.workspacePath, oninput: (e) => set('workspace')(e.target.value.trim()) }), 'Where it saves files and runs commands. Empty = its own folder in the dashboard data.'),
          h('div.row.mt', h('button.btn.ghost.small', { onclick: () => attempt(() => POST(`/agents/${id}/open-workspace`)) }, 'Open folder')),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'More')),
          h(
            'div.row',
            h('button.btn.ghost.small', { onclick: () => PUT(`/agents/${id}`, { pinned: !a.pinned }).then(() => ((a.pinned = !a.pinned), toast(a.pinned ? 'Pinned' : 'Unpinned'))) }, a.pinned ? 'Unpin' : 'Pin to top'),
            h('button.btn.ghost.small', { onclick: async () => {
              const c = await attempt(() => POST<Agent>(`/agents/${id}/duplicate`), 'Duplicated');
              if (c) navigate(`#/agents/${c.id}/edit`);
            } }, 'Clone'),
            historyButton('agent', id, () => {
              // put back: show it as it is now (changes not saved yet are dropped)
              dirty = false;
              void renderEditor(el, id);
            }),
            h('button.btn.ghost.small', { title: 'Keep it as a template you can create again in any project (Library > Your presets)', onclick: () => attempt(() => POST(`/presets/agent/${id}`), `Saved ${a.name} as a preset`) }, 'Save as preset'),
            h('button.btn.ghost.small', { title: 'Write it to ~/.claude/agents so any Claude Code session can use it', onclick: () => attempt(() => POST<{ file: string }>(`/agents/${id}/export-claude`), (r) => `Saved as ${r.file}`) }, 'Install in Claude Code'),
            h('button.btn.danger.small', { onclick: async () => {
              if (!(await confirmBox(`Delete ${a.name}? Its chats stay in the data folder.`, { ok: 'Delete', danger: true }))) return;
              if (await attempt(() => DEL(`/agents/${id}`), 'Deleted')) navigate('#/agents');
            } }, 'Delete'),
          ),
          h('p.hint.mt', `Id: ${a.id}${a.source?.type && a.source.type !== 'custom' ? ` · from ${a.source.type}${a.source.slug ? ` (${a.source.slug})` : ''}` : ''}`),
        ),
      ),
    ),
  );
  drawEngine();
  drawKnowledge();
  window.onbeforeunload = () => (dirty || memory.dirty() ? true : undefined);
}
