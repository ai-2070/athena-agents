// Artifacts: what the teams finished that isn't an outgoing post (a written result, a file, a folder),
// with a preview of each (images, video, audio, 3D models) and a search for when there are many.
import { h, mount, GET, DEL, attempt, md, copy, confirmBox } from '../core.ts';
import { icon } from '../icons.ts';
import { filePreviews } from '../filepreview.ts';
import { fileUrl } from '../client/connection.ts';
import type { Artifact, ServerEvent } from '../../shared/types.ts';

const when = (ts?: number) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Everything you can search an artifact by, in lower case. */
const haystack = (a: Artifact): string => [a.title, a.note, a.agentName, a.teamName, a.kind, a.path, (a.text || '').slice(0, 20_000)].filter(Boolean).join('\n').toLowerCase();

/** The artifacts that match every word typed (any order, any case). */
export function matching(list: readonly Artifact[], query: string): Artifact[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter((a) => {
    const hay = haystack(a);
    return words.every((w) => hay.includes(w));
  }) : [...list];
}

// The page in the left menu, under Outbox.
let root: HTMLElement | undefined;
let all: Artifact[] = [];
let query = '';
let listBox: HTMLElement | undefined;
let countEl: HTMLElement | undefined;

export const title = () => 'Artifacts';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  const input = h('input', { type: 'search', placeholder: 'Search by name, note, team, who made it, file name…', value: query, 'aria-label': 'Search artifacts', style: { width: '100%' } });
  input.addEventListener('input', () => {
    query = input.value;
    show();
  });
  countEl = h('span.hint');
  listBox = h('div.col');
  mount(root, h('div.row', { style: { marginBottom: '14px', gap: '12px' } }, h('div.grow', input), countEl), listBox);
  await reload();
}

export function unmount(): void {
  root = undefined;
  listBox = undefined;
}

export function onEvent(ev: ServerEvent): void {
  if (ev.type === 'artifacts' || ev.type === 'project') void reload();
}

async function reload(): Promise<void> {
  all = await GET<Artifact[]>('/artifacts');
  show();
}

function show(): void {
  if (!listBox || !countEl) return;
  const list = matching(all, query);
  countEl.textContent = query.trim() ? `${list.length} of ${all.length}` : all.length ? `${all.length}` : '';
  mount(
    listBox,
    list.length
      ? list.map(card)
      : h('div.empty.box', all.length ? `Nothing matches "${query.trim()}".` : 'Nothing yet. When a team finishes a result that is not a post or email, an agent saves it here with save_artifact.'),
  );
}

function card(a: Artifact) {
  const kindIcon = a.kind === 'folder' ? 'folder' : a.kind === 'file' ? 'file' : 'file-text';
  const who = [a.agentName ? `by ${a.agentName}` : '', a.teamName ? `team ${a.teamName}` : ''].filter(Boolean).join(' · ');
  return h(
    'div.panel',
    h('div.row', icon(kindIcon, 16), h('b', a.title), h('span.pill', a.kind), h('span.grow'), h('span.hint', { title: when(a.createdAt) }, `done ${when(a.createdAt)}`)),
    who ? h('div.hint.mt', who) : null,
    a.note ? h('p.hint.mt', a.note) : null,
    a.path ? h('div.hint.mono.mt', { style: { wordBreak: 'break-all' } }, a.path) : null,
    // the same preview the chats show: image, video, audio, a 3D model you can turn, or a card for other files and folders
    a.path ? h('div.mt', filePreviews([a.path])) : null,
    a.kind === 'text' && a.text ? h('details.mt', h('summary', 'Show the result'), md(a.text)) : null,
    h(
      'div.row.mt',
      a.kind === 'file' && a.path ? h('a.btn.ghost.small', { href: fileUrl(a.path), target: '_blank', rel: 'noopener' }, 'Open') : null,
      a.path ? h('button.btn.ghost.small', { onclick: () => copy(a.path!) }, 'Copy path') : null,
      a.text ? h('button.btn.ghost.small', { onclick: () => copy(a.text!) }, 'Copy text') : null,
      h('span.grow'),
      h('button.btn.danger.small', { onclick: async () => {
        if (!(await confirmBox(`Remove "${a.title}" from the list? The file or folder itself stays where it is.`, { ok: 'Remove', danger: true }))) return;
        await attempt(() => DEL(`/artifacts/${a.id}`));
        await reload();
      } }, 'Remove'),
    ),
  );
}
