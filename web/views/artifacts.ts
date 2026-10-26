// Artifacts: what the teams finished that isn't an outgoing post (a written result, a file, a folder).
import { h, mount, GET, POST, DEL, attempt, md, copy, confirmBox } from '../core.ts';
import type { ServerEvent } from '../../shared/types.ts';
import { icon } from '../icons.ts';
import type { Artifact } from '../../shared/types.ts';

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const fileUrl = (p: string) => `/api/file?path=${encodeURIComponent(p)}`;
const when = (ts?: number) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

// The page in the left menu, under Outbox.
let root: HTMLElement | undefined;
export const title = () => 'Artifacts';
export async function render(el: HTMLElement): Promise<void> {
  root = el;
  await draw();
}
export function unmount(): void {
  root = undefined;
}
export function onEvent(ev: ServerEvent): void {
  if (ev.type === 'artifacts' || ev.type === 'project') void draw();
}
async function draw(): Promise<void> {
  if (!root) return;
  const body = h('div');
  mount(root, body);
  await drawArtifacts(body, draw);
}

async function drawArtifacts(body: HTMLElement, redraw: () => unknown): Promise<void> {
  const list = await GET<Artifact[]>('/artifacts');
  mount(
    body,
    list.length
      ? h('div.col', list.map((a) => card(a, redraw)))
      : h('div.empty.box', 'Nothing yet. When a team finishes a result that is not a post or email, an agent saves it here with save_artifact.'),
  );
}

function card(a: Artifact, redraw: () => unknown) {
  const name = (a.path || '').split(/[\/]/).pop() || '';
  const kindIcon = a.kind === 'folder' ? 'folder' : a.kind === 'file' ? 'file' : 'file-text';
  const preview = a.kind === 'file' && a.path && IMAGE.test(a.path) ? h('img', { src: fileUrl(a.path), alt: name, style: { maxHeight: '160px', maxWidth: '100%', borderRadius: '8px', display: 'block' } }) : null;
  const who = [a.agentName ? `by ${a.agentName}` : '', a.teamName ? `team ${a.teamName}` : ''].filter(Boolean).join(' · ');
  return h(
    'div.panel',
    h('div.row', icon(kindIcon, 16), h('b', a.title), h('span.pill', a.kind), h('span.grow'), h('span.hint', { title: when(a.createdAt) }, `done ${when(a.createdAt)}`)),
    who ? h('div.hint.mt', who) : null,
    a.note ? h('p.hint.mt', a.note) : null,
    a.path ? h('div.hint.mono.mt', { style: { wordBreak: 'break-all' } }, a.path) : null,
    preview ? h('div.mt', preview) : null,
    a.kind === 'text' && a.text ? h('details.mt', h('summary', 'Show the result'), md(a.text)) : null,
    h(
      'div.row.mt',
      a.kind === 'file' && a.path ? h('a.btn.small', { href: fileUrl(a.path), target: '_blank' }, IMAGE.test(a.path) ? 'Open' : 'Download') : null,
      a.path ? h('button.btn.ghost.small', { onclick: () => attempt(() => POST('/files/reveal', { path: a.path }), 'Shown in your file manager') }, 'Show in folder') : null,
      a.path ? h('button.btn.ghost.small', { onclick: () => copy(a.path!) }, 'Copy path') : null,
      a.text ? h('button.btn.ghost.small', { onclick: () => copy(a.text!) }, 'Copy text') : null,
      h('span.grow'),
      h('button.btn.danger.small', { onclick: async () => {
        if (!(await confirmBox(`Remove "${a.title}" from the list? The file or folder itself stays where it is.`, { ok: 'Remove', danger: true }))) return;
        await attempt(() => DEL(`/artifacts/${a.id}`));
        redraw();
      } }, 'Remove'),
    ),
  );
}
