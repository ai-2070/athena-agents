// Settings: keys, defaults, local model servers, program paths, limits.
import { h, mount, GET, POST, PUT, attempt, field, seg, select, toast, refreshSoon, state } from '../core.js';

let root;
export const title = () => 'Settings';

export async function render(el) {
  root = el;
  await draw();
}

async function draw() {
  const { settings: s, secrets } = await GET('/settings');
  const st = state.data;
  const patch = {};
  const setP = (path, value) => {
    const keys = path.split('.');
    let o = patch;
    for (const k of keys.slice(0, -1)) o = o[k] ||= {};
    o[keys.at(-1)] = value;
  };
  const save = () => attempt(() => PUT('/settings', patch), 'Saved').then(() => refreshSoon(0));

  const secretField = (key, label, placeholder, hint) => {
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
          ? h('button.btn.ghost.small', { onclick: () => attempt(() => POST('/settings/test-openrouter'), (r) => `Key works${r.label ? ` (${r.label})` : ''}${r.limit_remaining != null ? ` · $${Number(r.limit_remaining).toFixed(2)} left` : r.usage != null ? ` · $${Number(r.usage).toFixed(2)} used` : ''}`) }, 'Test')
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
            ),
            secretField('openrouterKey', 'OpenRouter key', 'sk-or-…', h('span', 'One key for hundreds of models (Claude, GPT, Gemini, Llama, DeepSeek…). Get it at ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank' }, 'openrouter.ai/keys'), '. Also usable by Claude Code agents.')),
            secretField('anthropicKey', 'Anthropic API key (optional)', 'sk-ant-…', 'For Claude Code agents set to "Anthropic API key" instead of your subscription.'),
          ),
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
