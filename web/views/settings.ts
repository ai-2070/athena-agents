// Settings: keys, defaults, local model servers, program paths, limits.
import { h, mount, GET, POST, PUT, attempt, field, seg, select, toggleRow, toast, refreshSoon, state, navigate } from '../core.ts';
import { brainModelChip } from '../models.ts';
import { memoryButton, BRAIN } from '../memory.ts';
import type { Child } from '../core.ts';
import type { EngineStatus, SecretKey, SecretStatus, Settings, Terminal } from '../../shared/types.ts';

/** What POST /api/settings/test-openrouter passes on from OpenRouter's /key endpoint. */
interface OpenRouterKeyInfo {
  label?: string;
  limit_remaining?: number | null;
  usage?: number | null;
}

let root: HTMLElement;
export const title = () => 'Settings';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  await draw();
}

async function draw(): Promise<void> {
  const { settings: s, secrets } = await GET<{ settings: Settings; secrets: SecretStatus }>('/settings');
  const st = state.data!;
  const patch: Record<string, unknown> = {};
  const setP = (path: string, value: unknown) => {
    const keys = path.split('.');
    let o = patch;
    for (const k of keys.slice(0, -1)) o = (o[k] ||= {}) as Record<string, unknown>;
    o[keys.at(-1)!] = value;
  };
  const save = () => attempt(() => PUT('/settings', patch), 'Saved').then(() => refreshSoon(0));

  const secretField = (key: SecretKey, label: string, placeholder: string, hint?: Child) => {
    const input = h('input', { type: 'password', placeholder: secrets[key].set ? `saved (${secrets[key].hint}) · type to replace` : placeholder });
    return h(
      'div',
      field(label, input, hint),
      h(
        'div.row.mt',
        h('button.btn.small', { onclick: async () => {
          if (!input.value.trim()) return toast('Paste the key first', 'warn');
          await attempt(() => POST('/secrets', { key, value: input.value.trim() }), 'Saved');
          refreshSoon(0);
          draw();
        } }, 'Save'),
        secrets[key].set ? h('button.btn.ghost.small', { onclick: async () => (await attempt(() => POST('/secrets', { key, value: '' }), 'Removed'), refreshSoon(0), draw()) }, 'Remove') : null,
        key === 'openrouterKey' && secrets[key].set
          ? h('button.btn.ghost.small', { onclick: () => attempt(() => POST<OpenRouterKeyInfo>('/settings/test-openrouter'), (r) => `Key works${r.label ? ` (${r.label})` : ''}${r.limit_remaining != null ? ` · $${Number(r.limit_remaining).toFixed(2)} left` : r.usage != null ? ` · $${Number(r.usage).toFixed(2)} used` : ''}`) }, 'Test')
          : null,
      ),
    );
  };

  const cc = st.engines['claude-code'];
  mount(
    root,
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'AI keys')),
          h(
            'div.col.gap-lg',
            h(
              'div.kv',
              h('span', 'Claude Code'),
              h('span', cc.installed ? h('span', h('span.pill.ok', 'found'), ' ', cc.version || '', h('div.hint', 'Agents on "My Claude login" use your Claude subscription. Nothing to paste.')) : h('span.pill.bad', 'not installed')),
              h('span', 'Hermes'),
              h('span', st.engines.hermes.installed ? h('span.pill.ok', 'found') : h('span.pill', 'not installed')),
              ...cliRows(st.engines),
              h('span', 'OpenAI Codex'),
              h(
                'span',
                (() => {
                  const cx: Partial<EngineStatus['codex']> = st.engines.codex || {};
                  const btn = (label: string, fn: (e: MouseEvent) => unknown, ghost = true) => h(`button.btn.${ghost ? 'ghost.' : ''}tiny`, { onclick: fn }, label);
                  const signIn = async () => {
                    const t = await attempt(() => POST<Terminal>('/terminals', { kind: 'command', command: 'codex', args: ['login'], title: 'Codex sign-in' }));
                    if (t) navigate(`#/terminals/${t.id}`);
                  };
                  const recheck = () => attempt(() => POST<EngineStatus['codex']>('/codex/refresh'), (r) => (r.loggedIn ? 'Codex is signed in' : r.installed ? 'Installed, not signed in yet' : 'Not installed')).then(() => (refreshSoon(0), setTimeout(draw, 300)));
                  if (!cx.installed)
                    return h('span', h('span.pill', 'not installed'), ' ', btn('Install Codex', async (e) => {
                      (e.target as HTMLButtonElement).disabled = true;
                      (e.target as HTMLButtonElement).textContent = 'Installing…';
                      await attempt(() => POST<{ message: string }>('/codex/install'), (r) => r.message);
                      refreshSoon(0);
                      setTimeout(draw, 500);
                    }, false), h('div.hint', 'Installs the official CLI with npm (npm install -g @openai/codex). Then sign in with your ChatGPT account.'));
                  return h('span', cx.loggedIn ? h('span.pill.ok', 'signed in') : h('span.pill.warn', 'not signed in'), ' ', cx.version || '', ' ', cx.loggedIn ? null : btn('Sign in', signIn, false), ' ', btn('Recheck', recheck), h('div.hint', cx.loggedIn ? 'Agents set to Codex use your ChatGPT login.' : 'Sign in opens a terminal running "codex login": follow the link, then press Recheck.'));
                })(),
              ),
            ),
            secretField('openrouterKey', 'OpenRouter key', 'sk-or-…', h('span', 'One key for hundreds of models (Claude, GPT, Gemini, Llama, DeepSeek…). Get it at ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank' }, 'openrouter.ai/keys'), '. Also usable by Claude Code agents.')),
            secretField('anthropicKey', 'Anthropic API key (optional)', 'sk-ant-…', 'For Claude Code agents set to "Anthropic API key" instead of your subscription.'),
          ),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', "The Brain's model")),
          h('p.hint', 'The Brain oversees the project: it answers about the project and its files, builds teams and agents, writes PROJECT.md and hands work out. It can run on Claude Code, OpenRouter, Hermes or Codex. Claude Code and Codex can also open files in the project folder.'),
          h('div.row.mt', field('Model', brainModelChip({ prefix: '', onChange: (b) => (s.brain = b) }))),
          h('div.row.mt', memoryButton(BRAIN, 'The Brain'), h('span.hint', 'What the Brain remembers across its conversations in this project. Read or change it any time.')),
          toggleRow(
            s.brainApproves !== false,
            async (on) => {
              const saved = await attempt(() => PUT('/settings', { brainApproves: on }), on ? 'The Brain approves for you' : 'Every request comes to you');
              // didn't save: redraw so the switch shows what is really set
              if (saved) refreshSoon(0);
              else await draw();
            },
            'The Brain approves',
            '.mt',
          ),
          h('p.hint', "When an agent or team asks permission, the Brain allows routine, on-task work by itself and only passes the risky or unclear requests (deleting, pushing, sending, secrets, anything outside the project) to Needs you. Workflow checkpoints and Outbox posts and DMs always wait for you."),
          toggleRow(
            s.brainFollowsUp !== false,
            async (on) => {
              const saved = await attempt(() => PUT('/settings', { brainFollowsUp: on }), on ? 'The Brain checks on the work it hands out' : 'The Brain hands work out and leaves it to them');
              if (saved) refreshSoon(0);
              else await draw();
            },
            'The Brain follows up',
            '.mt',
          ),
          h('p.hint', 'When a team or agent finishes work the Brain handed them, it checks the result. Something missing: it asks them for it (twice at most). Done, stuck, or they need you: it tells you in the Brain chat. Off: it only hands the work out, and stops checking on work it handed out before.'),
          toggleRow(
            s.brainAnyGitHub === true,
            async (on) => {
              const saved = await attempt(() => PUT('/settings', { brainAnyGitHub: on }), on ? 'The Brain may install skills from any GitHub link' : 'The Brain installs only from links you give');
              if (saved) refreshSoon(0);
              else await draw();
            },
            'Install skills from any GitHub link',
            '.mt',
          ),
          h('p.hint', "Off: the Brain installs skills only from GitHub repos you named in the Brain chat yourself. On: also from links it finds in files, pages or agents' answers. Skills are instructions your agents follow, so only turn this on if you trust where those links come from."),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Defaults for new agents')),
          h(
            'div.col',
            field('Brain', seg(st.engineList.map((e) => ({ value: e.id, label: e.label })), s.defaults.engine, (v) => setP('defaults.engine', v))),
            h('div.grid-2', field('Claude Code model', h('input', { value: s.defaults.claudeModel, oninput: (e) => setP('defaults.claudeModel', e.target.value) })), field('API model', h('input.code', { value: s.defaults.openrouterModel, oninput: (e) => setP('defaults.openrouterModel', e.target.value) }))),
            field('Autonomy', seg([{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }], s.defaults.autonomy, (v) => setP('defaults.autonomy', v))),
          ),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Limits')),
          h(
            'div.grid-2',
            field('Max tool steps per message', h('input', { type: 'number', min: 1, max: 100, value: s.maxToolSteps, oninput: (e) => setP('maxToolSteps', Number(e.target.value)) }), 'API-model agents stop after this many tool rounds.'),
            field('Cost limit per message (USD)', h('input', { type: 'number', min: 0, step: '0.5', value: s.costLimitUsdPerRun, oninput: (e) => setP('costLimitUsdPerRun', Number(e.target.value)) }), 'OpenRouter runs stop past this. 0 = no limit.'),
          ),
        ),
        (() => {
          // Settings > Chat memory: compacting long chats (server/compaction.ts)
          const c = s.compaction;
          return h(
            'div.panel#chat-memory',
            h('div.panel-head', h('h2', 'Chat memory')),
            h('p.hint', 'Long chats fill up the model’s memory. Compacting turns the older messages into a short history the agent keeps reading, and keeps the latest messages in full. Every message stays in the chat for you, marked “COMPACTED” where it happened; open the mark to read or edit what the agent remembers. You can also press Compact in a chat, or type /compact.'),
            toggleRow(c.auto, (on) => setP('compaction.auto', on), 'Compact long chats automatically', '.mt'),
            toggleRow(c.instant, (on) => setP('compaction.instant', on), 'Instant compaction', '.mt'),
            h('p.hint', 'Instant keeps the original words, cut to fit: long messages are shortened, tool calls become one line and their results are left out (the agent can read any of them back). No model call, so it takes no time and costs nothing. Off: the Brain’s model writes a summary instead (slower, smaller).'),
            h(
              'div.grid-2.mt',
              field('Messages kept in full', h('input', { type: 'number', min: 0, max: 1000, value: c.keepMessages, oninput: (e) => setP('compaction.keepMessages', Number(e.target.value)) }), 'Up to this many of the latest messages (yours and the agent’s, with their tool calls) stay word for word, as far as the size budget allows. The rest is compacted.'),
              field('Compact at (% of the context window)', h('input', { type: 'number', min: 10, max: 95, value: c.thresholdPercent, oninput: (e) => setP('compaction.thresholdPercent', Number(e.target.value)) }), 'Compacts when the agent’s memory of a chat reaches this share of the model’s context window.'),
            ),
            h(
              'div.mt',
              field(
                'Context window (tokens)',
                h('input', { type: 'number', min: 0, step: 1000, value: c.windowTokens || '', placeholder: 'auto', oninput: (e) => setP('compaction.windowTokens', Number(e.target.value) || 0) }),
                'Leave empty to use what each engine or model says (Claude Code 200k, or 1M for a “[1m]” model). Set 1000000 if your models have a 1M-token window: everything the compaction keeps grows with the window.',
              ),
            ),
          );
        })(),
        h('div.row', h('button.btn', { onclick: save }, 'Save settings')),
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Local and custom models')),
          h(
            'div.col',
            field('LM Studio server', h('input.code', { value: s.providers.lmstudio.baseUrl, oninput: (e) => setP('providers.lmstudio.baseUrl', e.target.value) }), 'In LM Studio: Developer > Start server.'),
            field('Ollama server', h('input.code', { value: s.providers.ollama.baseUrl, oninput: (e) => setP('providers.ollama.baseUrl', e.target.value) })),
            field('Custom OpenAI-compatible URL', h('input.code', { value: s.providers.custom.baseUrl, placeholder: 'https://api.example.com/v1', oninput: (e) => setP('providers.custom.baseUrl', e.target.value) })),
            secretField('customKey', 'Custom provider key', 'key'),
          ),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Programs')),
          h(
            'div.col',
            field('ComfyUI address', h('input.code', { value: s.comfyui.url, placeholder: 'auto (tries :8188 and :8000)', oninput: (e) => setP('comfyui.url', e.target.value.trim()) })),
            field('Extra ComfyUI workflow folders', h('textarea.code', { rows: 2, value: (s.comfyui.workflowDirs || []).join('\n'), placeholder: 'One folder per line', oninput: (e) => setP('comfyui.workflowDirs', e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) })),
            h('p.hint', 'Paths below are found automatically. Set one only to pick a different version.'),
            ['blender', 'premiere', 'photoshop', 'aftereffects', 'comfyui'].map((k) => field(`${k} path`, h('input.code', { value: s.paths[k] || '', placeholder: 'auto', oninput: (e) => setP(`paths.${k}`, e.target.value.trim()) }))),
          ),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Allowed folders')),
          field('Folders every agent may read and write (file tools)', h('textarea.code', { rows: 3, value: (s.allowedFolders || []).join('\n'), placeholder: 'C:\\Users\\you\\Videos', oninput: (e) => setP('allowedFolders', e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) }), 'Each agent can always use its own workspace and knowledge.'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'About')),
          h('div.kv', h('span', 'Address'), h('span.mono', `http://localhost:${st.port}`), h('span', 'Login'), h('span', 'None. Only this PC can open it (it listens on 127.0.0.1).'), h('span', 'Data'), h('span.mono', { style: { overflowWrap: 'anywhere' } }, st.dataDir)),
          h('p.hint.mt', 'Keys and account tokens are stored in that data folder on this PC and never sent to the browser.'),
        ),
      ),
    ),
  );
}

// pi, oh-my-pi and OpenClaw: found or not, and how to install them (they sign in to models in their own terminal).
function cliRows(e: EngineStatus): HTMLElement[] {
  const rows: [keyof EngineStatus & ('pi' | 'omp' | 'openclaw'), string, string][] = [
    ['pi', 'pi coding agent', 'Install: npm install -g @earendil-works/pi-coding-agent. Sign in to a model provider with /login in pi.'],
    ['omp', 'oh-my-pi', 'Install: bun install -g @oh-my-pi/pi-coding-agent (needs Bun). Sign in with /login in omp.'],
    ['openclaw', 'OpenClaw', 'Install: npm install -g openclaw, then run openclaw onboard.'],
  ];
  return rows.flatMap(([id, label, how]) => {
    const s: Partial<EngineStatus['pi']> = e[id] || {};
    return [h('span', label), h('span', s.installed ? h('span', h('span.pill.ok', 'found'), ' ', s.version || '') : h('span', h('span.pill', 'not installed'), h('div.hint', how)))];
  });
}
