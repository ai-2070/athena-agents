// Programs: what's installed and running on this PC, ComfyUI, and every Start Menu app.
import { h, mount, clear, GET, POST, attempt, lightbox, field, select, toast, navigate } from '../core.js';

let root;
export const title = () => 'Programs';

const CATS = [
  ['ai', 'AI tools'],
  ['creative', 'Creative'],
  ['browser', 'Browsers'],
  ['dev', 'Developer'],
  ['office', 'Other'],
];

const ABOUT = {
  claude: 'Agents run on it. Open it in a terminal from Terminals.',
  hermes: 'Agents run on your Hermes profiles; hermes_ask lets any agent consult one.',
  orca: 'Agents with the Orca tools can run Orca commands.',
  comfyui: 'Agents with ComfyUI tools run your saved workflows.',
  lmstudio: 'Start its local server to use local models (API model > LM Studio).',
  ollama: 'Local models through API model > Ollama.',
  netdesk: 'Your team social desk.',
  blender: 'Agents run Blender Python headless: build, render, export.',
  premiere: 'Agents open projects; edits go through ffmpeg or a Premiere MCP.',
  photoshop: 'Agents run ExtendScript in it.',
  aftereffects: 'Agents run ExtendScript in it.',
  ffmpeg: 'Agents cut, convert and inspect video and audio.',
  chrome: 'open_url can target it; add the Playwright MCP for full control.',
};

export async function render(el) {
  root = el;
  mount(el, h('p.dim', 'Looking around this PC…'));
  await draw(false);
}

async function draw(force) {
  const [progs, comfy] = await Promise.all([GET(`/programs${force ? '?force=1' : ''}`), GET('/comfyui').catch(() => null)]);
  const allBox = h('div');
  mount(
    root,
    h('div.row.between', { style: { marginBottom: '14px' } }, h('p.lede', { style: { margin: 0 } }, `Found ${progs.filter((p) => p.installed).length} programs. Agents can use the ones with tools; you can start any of them from here.`), h('button.btn.ghost.small', { onclick: () => draw(true) }, 'Scan again')),
    comfyPanel(comfy),
    CATS.map(([cat, label]) => {
      const list = progs.filter((p) => p.category === cat && p.installed);
      if (!list.length) return null;
      return h(
        'div.mt-lg',
        h('h2.section', label),
        h(
          'div.cards',
          list.map((p) =>
            h(
              'div.card',
              h('div.card-top', h('div.avatar', p.icon), h('div.grow', h('div.card-title', p.name), h('div.hint', [p.version ? `v${p.version}` : p.cli ? 'command line' : 'installed', p.running ? ' · running' : ''].join('')))),
              h('span.corner', h('span', { class: `dot ${p.running ? 'on' : ''}` })),
              ABOUT[p.id] ? h('div.card-sub', ABOUT[p.id]) : null,
              h(
                'div.card-foot',
                p.actions.includes('launch') || (!p.cli && p.exe) ? h('button.btn.small', { onclick: () => attempt(() => POST('/programs/launch', { program: p.id }), (r) => r.message) }, 'Start') : null,
                p.serviceUrl ? h('a.btn.ghost.small', { href: p.serviceUrl, target: '_blank' }, 'Open') : null,
                p.actions.includes('terminal') ? h('button.btn.ghost.small', { onclick: () => openCli(p) }, 'Terminal') : null,
              ),
            ),
          ),
        ),
      );
    }),
    h(
      'div.mt-lg',
      h('h2.section', 'Not found'),
      h('p.hint', progs.filter((p) => !p.installed).map((p) => p.name).join(', ') || 'Everything in the catalog was found.', ' Set custom paths in Settings.'),
    ),
    h('div.mt-lg', h('h2.section', 'All apps (Start Menu)'), allBox),
  );
  drawAll(allBox);
}

async function openCli(p) {
  const cmd = { claude: 'claude', hermes: 'hermes', orca: 'orca', gh: 'gh', python: 'python' }[p.id];
  const t = await attempt(() => POST('/terminals', { kind: 'command', command: cmd, args: p.id === 'orca' ? ['status'] : [] }));
  if (t) navigate(`#/terminals/${t.id}`);
}

async function drawAll(box) {
  const apps = await GET('/programs/all');
  const list = h('div.cards', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } });
  const fill = (q = '') => {
    const ql = q.toLowerCase();
    const shown = apps.filter((a) => !ql || a.name.toLowerCase().includes(ql) || a.folder.toLowerCase().includes(ql)).slice(0, 120);
    mount(
      list,
      shown.map((a) =>
        h('div.card', { style: { padding: '10px 12px', flexDirection: 'row', alignItems: 'center' } }, h('div.grow', h('div', { style: { fontWeight: 600, fontSize: '14px' } }, a.name), a.folder ? h('div.hint', a.folder) : null), h('button.btn.tiny.ghost', { onclick: () => attempt(() => POST('/programs/launch', { program: a.name }), (r) => r.message) }, 'Start')),
      ),
    );
  };
  mount(box, h('div', { style: { maxWidth: '420px', marginBottom: '12px' } }, h('input', { placeholder: `Search ${apps.length} apps`, oninput: (e) => fill(e.target.value) })), list);
  fill();
}

function comfyPanel(comfy) {
  if (!comfy) return null;
  const st = comfy.status;
  const out = h('div.tool-images.mt');
  let wfName = comfy.workflows[0]?.name || '';
  const prompt = h('textarea', { rows: 2, placeholder: 'Prompt (replaces the positive prompt in the workflow)' });
  const btn = h('button.btn', {
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      const r = await attempt(() => POST('/comfyui/run', { workflow: wfName, prompt: prompt.value || undefined }));
      btn.disabled = false;
      btn.textContent = 'Run';
      if (r) {
        mount(out, r.files.filter((f) => f.kind === 'images').map((f) => h('img', { src: f.url, onclick: () => lightbox(f.url) })));
        if (r.warnings?.length) toast(r.warnings.join(' '), 'warn', 8000);
      }
    },
  }, 'Run');
  return h(
    'div.panel',
    h(
      'div.panel-head',
      h('h2', '🧩 ComfyUI'),
      h('span', { class: `pill ${st.running ? 'ok' : ''}` }, st.running ? `running · ${st.url}` : 'not running'),
      st.devices?.[0] ? h('span.pill', `${st.devices[0].name.replace(/^cuda:\d+\s*/, '').slice(0, 40)} · ${st.devices[0].vramFreeGB}/${st.devices[0].vramTotalGB} GB free`) : null,
      h(
        'div.actions',
        !st.running ? h('button.btn.small', { onclick: () => attempt(() => POST('/comfyui/start'), 'Starting ComfyUI… give it a minute').then(() => setTimeout(() => draw(true), 20000)) }, 'Start ComfyUI') : h('a.btn.ghost.small', { href: st.url, target: '_blank' }, 'Open ComfyUI'),
      ),
    ),
    comfy.workflows.length
      ? h(
          'div.col',
          h('div.grid-2', field('Workflow', select(comfy.workflows.map((w) => w.name), wfName, (v) => (wfName = v))), h('div')),
          prompt,
          h('div.row', btn, h('span.hint', st.running ? 'Images appear below. Agents with the ComfyUI tools can do the same.' : 'Start ComfyUI first.')),
          out,
        )
      : h('p.hint', 'No saved workflows found. Save one in ComfyUI (Workflow > Save), or drop an API-format JSON into the dashboard data/comfy-workflows folder.'),
  );
}
