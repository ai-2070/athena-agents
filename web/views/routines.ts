// Routines: instructions you run again and again. Type @ in the text to mention who does it (agents,
// teams) and which skills they use. Run it by hand or on a schedule.
import { h, mount, state, GET, POST, PUT, DEL, attempt, navigate, field, confirmBox, ago } from '../core.ts';
import type { Child } from '../core.ts';
import { icon } from '../icons.ts';
import { uiZoom } from '../look.ts';
import { loadSkills, skillsCache } from '../skillpick.ts';
import { scheduleEditor, scheduleText } from '../schedule.ts';
import { openChat } from '../chatwin.ts';
import { findMentions, mentionQuery } from '../../shared/routines.ts';
import type { Routine, RoutineListing, RoutineMention, RoutineMentionKind, RoutineRun, RoutineRunTarget, ServerEvent, TeamListing } from '../../shared/types.ts';

let root: HTMLElement | undefined;
let params: string[] = [];
let teams: TeamListing[] = [];
let editing: Routine | null = null;
let runsEl: HTMLElement | null = null;
let listTimer: ReturnType<typeof setTimeout> | undefined;
// Bumped on every render and on leaving the page: a load that finishes after that draws nothing
// (the view element is shared by every page, so being connected isn't enough).
let generation = 0;

export const title = (p: string[]) => (p[0] ? 'Routine' : 'Routines');

export async function render(el: HTMLElement, p: string[]): Promise<void> {
  const mine = ++generation;
  root = el;
  params = p;
  editing = null;
  runsEl = null;
  mount(el, h('p.dim', 'Loading routines…'));
  [teams] = await Promise.all([GET<TeamListing[]>('/workflows').catch((): TeamListing[] => []), loadSkills()]);
  if (mine !== generation) return;
  if (p[0]) return renderEditor(p[0]);
  return renderList();
}

export function unmount(): void {
  generation++;
  root = undefined;
  editing = null;
  runsEl = null;
  closeMenu();
  clearTimeout(listTimer);
  clearTimeout(runsTimer);
}

export function onEvent(ev: ServerEvent): void {
  if (!root?.isConnected) return;
  if (ev.type === 'routine-run') {
    if (editing && ev.routineId === editing.id) drawRuns();
    else if (!params[0]) refreshList();
  }
  if (ev.type === 'routines' && !params[0]) refreshList();
  if (['agents', 'workflows'].includes(ev.type)) GET<TeamListing[]>('/workflows').then((t) => (teams = t)).catch(() => {});
}

function refreshList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => !params[0] && root?.isConnected && renderList(), 200);
}

// ---------- what a routine can mention ----------
interface Candidate extends RoutineMention {
  lead: Child;
  sub: string;
  color?: string;
}

const KIND_LABEL: Record<RoutineMentionKind, string> = { agent: 'Agents', team: 'Teams', skill: 'Skills' };

// agents first: on a name clash they win (the server does the same)
function candidates(): Candidate[] {
  const d = state.data!;
  return [
    ...d.agents.map((a): Candidate => ({ kind: 'agent', id: a.id, name: a.name, lead: h('span.rt-emoji', a.emoji || '🤖'), sub: a.specialty || a.description || '', color: a.color })),
    ...teams.map((t): Candidate => ({ kind: 'team', id: t.id, name: t.name, lead: icon('users', 14), sub: `${t.members.length} member${t.members.length === 1 ? '' : 's'}${t.description ? ` · ${t.description}` : ''}`, color: t.color })),
    ...skillsCache().map((s): Candidate => ({ kind: 'skill', id: s.slug, name: s.name, lead: icon('puzzle', 14), sub: s.description })),
  ];
}

function mentionChip(m: RoutineMention, extra: Child = null): HTMLElement {
  const d = state.data!;
  const a = m.kind === 'agent' ? d.agents.find((x) => x.id === m.id) : null;
  const t = m.kind === 'team' ? teams.find((x) => x.id === m.id) : null;
  const lead = m.kind === 'agent' ? h('span', a?.emoji || '🤖') : icon(m.kind === 'team' ? 'users' : 'puzzle', 11);
  return h(`span.rt-m.${m.kind}${m.missing ? '.missing' : ''}`, { style: t?.color ? { '--c': t.color } : null, title: m.missing ? `${m.name} no longer exists` : KIND_LABEL[m.kind].slice(0, -1) }, lead, m.name, extra);
}

function mentionChips(list: readonly RoutineMention[]): Child {
  return list.length ? h('div.rt-ms', list.map((m) => mentionChip(m))) : null;
}

// ---------- the list ----------
async function renderList() {
  const mine = generation;
  const list = await GET<RoutineListing[]>('/routines');
  if (mine !== generation || !root?.isConnected || params[0]) return;
  mount(
    root,
    h('p.lede', 'A routine is work you want done again and again: a morning news check, a weekly report, a content plan. Write it once, @mention the agents and teams who do it and the skills they should use, then run it by hand or on a schedule.'),
    h('div.row.between', { style: { marginBottom: '14px' } }, h('h2.section', { style: { margin: 0 } }, `Your routines${list.length ? ` (${list.length})` : ''}`), h('button.btn.small', { onclick: create }, icon('plus', 14), 'New routine')),
    list.length
      ? h('div.rt-grid', list.map(card))
      : h(
          'div.empty.box',
          h('p', { style: { margin: '0 0 12px' } }, 'No routines yet.'),
          h('p.hint', { style: { margin: '0 auto 14px', maxWidth: '520px' } }, 'Example: "Every morning, @Researcher finds the 3 biggest AI stories, then @Content Team turns them into a post using @Brand voice."'),
          h('button.btn.small', { onclick: create }, icon('plus', 14), 'Write your first routine'),
        ),
  );
}

async function create() {
  const r = await attempt(() => POST<Routine>('/routines', { name: 'New routine' }));
  if (r) navigate(`#/routines/${r.id}`);
}

function card(r: RoutineListing) {
  const last = r.lastRun;
  const sched = r.schedule && r.schedule.type !== 'none';
  return h(
    'div.rt-card',
    { onclick: () => navigate(`#/routines/${r.id}`) },
    h('div.skill-top', h('div.skill-ico', icon('repeat', 18)), h('div.grow', h('div.skill-name', r.name), h('div.hint', sched ? (r.enabled ? scheduleText(r.schedule) : `${scheduleText(r.schedule)} · off`) : 'run by hand'))),
    r.description || r.text ? h('p.skill-desc', r.description || r.text) : h('p.skill-desc.faint', 'Nothing written yet.'),
    mentionChips(r.mentions) || h('span.hint', 'Nobody mentioned yet'),
    h(
      'div.skill-foot',
      h('button.btn.small', {
        onclick: async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          btn.disabled = true;
          await attempt(() => POST(`/routines/${r.id}/run`, {}), 'Routine started');
          btn.disabled = false;
        },
      }, icon('play', 13), 'Run'),
      h('span.grow'),
      last ? h('span.hint', statusIcon(last.status), ` ${last.status} · ${ago(last.createdAt)}`) : h('span.hint', 'never run'),
    ),
  );
}

function statusIcon(st: string): HTMLElement {
  if (st === 'done' || st === 'sent') return h('span.accent', '✓');
  if (st === 'failed') return h('span.red', '✕');
  if (st === 'running') return h('span.dot.busy');
  if (st === 'stopped') return h('span.amber', '■');
  return h('span.faint', '·');
}

// ---------- the editor ----------
async function renderEditor(id: string) {
  const mine = generation;
  const r = await GET<Routine>(`/routines/${id}`).catch(() => null);
  if (mine !== generation || !root?.isConnected || params[0] !== id) return;
  if (!r) {
    mount(root, h('p', 'Routine not found. ', h('a', { href: '#/routines' }, 'Back to routines')));
    return;
  }
  editing = r;
  const missing = r.mentions.filter((m) => m.missing);
  let dirty = false;
  const saveBtn = h('button.btn', { disabled: true, onclick: () => save() }, 'Save');
  const mark = () => {
    dirty = true;
    saveBtn.disabled = false;
  };
  const save = async (): Promise<boolean> => {
    saveBtn.disabled = true;
    const out = await attempt(() => PUT<Routine>(`/routines/${id}`, { name: r.name, description: r.description || '', text: r.text, schedule: r.schedule, enabled: r.enabled }), 'Saved');
    if (!out) {
      saveBtn.disabled = false;
      return false;
    }
    r.mentions = out.mentions;
    dirty = false;
    return true;
  };

  const text = h('textarea.rt-text', { rows: 9, value: r.text, placeholder: 'What should be done? Type @ to mention who does it and the skills to use.\n\ne.g. @Researcher find the 3 most interesting AI stories from the last day, with links. Then @Content Team writes one X post about the best one using @Brand voice.' });
  const who = h('div.rt-who');
  const drawWho = () => {
    const found = findMentions(text.value, candidates());
    const mTeams = found.filter((m) => m.kind === 'team');
    const mAgents = found.filter((m) => m.kind === 'agent');
    const mSkills = found.filter((m) => m.kind === 'skill');
    const viaTeam = (agentId: string) => mTeams.map((m) => teams.find((t) => t.id === m.id)).find((t) => t?.members.includes(agentId));
    const gone = missing.filter((m) => findMentions(text.value, [m]).length);
    const doers = [
      ...mTeams.map((m) => mentionChip(m)),
      ...mAgents.map((m) => {
        const t = viaTeam(m.id);
        return mentionChip(m, t ? h('span.rt-via', `in ${t.name}`) : null);
      }),
    ];
    const row = (label: string, ico: string, items: HTMLElement[], empty: string) => h('div.rt-who-row', h('div.rt-who-label', icon(ico, 13), label), h('div.rt-ms', items.length ? items : h('span.hint', empty)));
    mount(
      who,
      row('Who does it', 'users', doers, 'Mention at least one agent or team.'),
      row('Skills', 'puzzle', mSkills.map((m) => mentionChip(m)), 'None. Mention a skill to have them follow it.'),
      gone.length ? h('p.hint.amber', icon('triangle-alert', 12), ` ${gone.map((m) => `@${m.name}`).join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted, so ${gone.length === 1 ? 'it is' : 'they are'} left out.`) : null,
    );
  };
  text.addEventListener('input', () => {
    r.text = text.value;
    mark();
    drawWho();
  });
  attachMentions(text, () => drawWho());
  const insertBtn = (kind: RoutineMentionKind, label: string, ico: string) =>
    h('button.btn.ghost.tiny', { type: 'button', title: `Mention ${label.toLowerCase()}`, onclick: () => startMention(text, kind) }, icon(ico, 12), label);

  const runInput = h('textarea', { rows: 2, placeholder: 'Optional: anything extra for this run' });
  runsEl = h('div.col');
  mount(
    root,
    h('div.row.between', { style: { marginBottom: '16px' } }, h('a.btn.ghost.small', { href: '#/routines' }, '← Routines'), h('div.row', saveBtn)),
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.grid-2', field('Name', h('input', { value: r.name, oninput: (e) => ((r.name = e.target.value), mark()) })), field('Description', h('input', { value: r.description || '', placeholder: 'Optional, shown on the card', oninput: (e) => ((r.description = e.target.value), mark()) }))),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'What to do'), h('div.actions', insertBtn('agent', 'Agent', 'bot'), insertBtn('team', 'Team', 'users'), insertBtn('skill', 'Skill', 'puzzle'))),
          text,
          h('p.hint', 'Type ', h('b', '@'), ' to mention an agent, a team or a skill. Mentioned agents and teams each get the routine (an agent in a mentioned team gets it in that team chat); mentioned skills are given to all of them for it.'),
          who,
        ),
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Run it')),
          runInput,
          h('div.row.mt', h('button.btn', {
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (dirty && !(await save())) return;
              btn.disabled = true;
              const out = await attempt(() => POST(`/routines/${id}/run`, { input: runInput.value }), 'Routine started');
              btn.disabled = false;
              if (out) {
                runInput.value = '';
                drawRuns();
              }
            },
          }, icon('play', 14), 'Run now')),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Schedule')), scheduleEditor(r, mark, { inputLabel: 'Extra for scheduled runs (optional)' })),
        h('div.panel', h('div.panel-head', h('h2', 'Runs')), runsEl),
        h('div.row', h('button.btn.danger.small', {
          onclick: async () => {
            if (!(await confirmBox(`Delete the routine "${r.name}"?`, { ok: 'Delete', danger: true }))) return;
            if (await attempt(() => DEL(`/routines/${id}`), 'Deleted')) navigate('#/routines');
          },
        }, 'Delete routine')),
      ),
    ),
  );
  drawWho();
  drawRuns();
}

// ---------- runs ----------
let runsTimer: ReturnType<typeof setTimeout> | undefined;
function drawRuns() {
  clearTimeout(runsTimer);
  runsTimer = setTimeout(async () => {
    const el = runsEl;
    const r = editing;
    if (!el?.isConnected || !r) return;
    const list = await GET<RoutineRun[]>(`/routine-runs?routineId=${encodeURIComponent(r.id)}`).catch((): RoutineRun[] => []);
    if (runsEl !== el || !el.isConnected) return; // left the page meanwhile
    // keep open whichever run was open
    const open = new Set([...el.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.id));
    mount(
      el,
      list.length
        ? list.slice(0, 15).map((run, i) =>
            h(
              'details',
              { open: open.size ? open.has(run.id) : i === 0, dataset: { id: run.id } },
              h(
                'summary.rt-run-head',
                statusIcon(run.status),
                h('b', run.status),
                h('span.hint', `${ago(run.createdAt)} · ${run.trigger}`),
                run.status === 'running' ? h('button.btn.tiny.danger', { onclick: (e) => (e.preventDefault(), attempt(() => POST(`/routine-runs/${run.id}/stop`))) }, 'Stop') : null,
              ),
              run.targets.map(targetRow),
              run.skills.length ? h('div.hint', 'Skills: ', run.skills.map((slug) => skillsCache().find((s) => s.slug === slug)?.name || slug).join(', ')) : null,
            ),
          )
        : h('p.empty', 'No runs yet.'),
    );
  }, 150);
}

function targetRow(t: RoutineRunTarget): HTMLElement {
  const open =
    t.kind === 'team'
      ? h('button.btn.ghost.tiny', { onclick: () => openChat('team', t.id) }, icon('message-square', 12), 'Team chat')
      : t.chatId
        ? h('a.btn.ghost.tiny', { href: `#/agents/${t.id}/${t.chatId}` }, icon('message-square', 12), 'Chat')
        : null;
  return h(
    'div.run-step',
    statusIcon(t.status),
    h('div', h('div.row', { style: { gap: '8px' } }, h('b', t.name), h('span.hint', t.kind === 'team' ? `team · ${t.status}` : t.status), h('span.grow'), open), t.output ? h('pre', t.output) : null),
  );
}

// ---------- @mentions in the text ----------
interface MenuState {
  el: HTMLElement;
  ta: HTMLTextAreaElement;
  start: number;
  kind: RoutineMentionKind | null;
  items: Candidate[];
  active: number;
  onPick: () => void;
}
let menu: MenuState | null = null;

function closeMenu() {
  menu?.el.remove();
  menu = null;
}

// Watches a textarea for "@…" and offers what it can mention.
function attachMentions(ta: HTMLTextAreaElement, onPick: () => void) {
  const update = () => {
    const q = mentionQuery(ta.value, ta.selectionStart);
    if (!q || ta.selectionStart !== ta.selectionEnd) return closeMenu();
    openMenu(ta, q.start, q.query, menu?.ta === ta && menu.start === q.start ? menu.kind : null, onPick);
  };
  ta.addEventListener('input', update);
  ta.addEventListener('click', update);
  ta.addEventListener('blur', () => setTimeout(() => menu?.ta === ta && document.activeElement !== ta && closeMenu(), 150));
  ta.addEventListener('keydown', (e) => {
    if (!menu || menu.ta !== ta) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = menu.items.length;
      if (n) menu.active = (menu.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintActive();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && menu.items.length) {
      e.preventDefault();
      pick(menu.items[menu.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  });
}

// The toolbar buttons: put an "@" at the caret and show only that kind.
function startMention(ta: HTMLTextAreaElement, kind: RoutineMentionKind) {
  ta.focus();
  const at = ta.selectionStart;
  const before = ta.value.slice(0, at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  ta.setRangeText(`${lead}@`, at, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
  if (menu?.ta === ta) openMenu(ta, menu.start, '', kind, menu.onPick);
}

function openMenu(ta: HTMLTextAreaElement, start: number, query: string, kind: RoutineMentionKind | null, onPick: () => void) {
  const q = query.toLowerCase().trim();
  const all = candidates().filter((c) => !kind || c.kind === kind);
  // names that start with what you typed first, then names that contain it
  const items = [...all.filter((c) => c.name.toLowerCase().startsWith(q)), ...all.filter((c) => q && !c.name.toLowerCase().startsWith(q) && `${c.name} ${c.sub}`.toLowerCase().includes(q))].slice(0, 30);
  if (!items.length && q.includes(' ')) return closeMenu(); // typing on past a name: not a mention
  const el = menu?.ta === ta ? menu.el : h('div.st-menu.skp-menu.rt-menu');
  if (!el.isConnected) document.body.append(el);
  // keep the menu's own scroll and clicks from moving focus out of the text
  el.onmousedown = (e) => e.preventDefault();
  menu = { el, ta, start, kind, items, active: 0, onPick };
  const groups = (['agent', 'team', 'skill'] as const).map((k) => ({ k, list: items.filter((c) => c.kind === k) })).filter((g) => g.list.length);
  // the order on screen is the order for the arrow keys
  menu.items = groups.flatMap((g) => g.list);
  mount(
    el,
    h('div.st-menu-head', kind ? `Mention ${KIND_LABEL[kind].slice(0, -1).toLowerCase()}` : 'Mention'),
    h(
      'div.model-list',
      groups.length
        ? groups.map((g) => [
            groups.length > 1 || !kind ? h('div.rt-menu-group', KIND_LABEL[g.k]) : null,
            g.list.map((c) => h('button.st-menu-item.rt-menu-item', { type: 'button', onclick: () => pick(c) }, c.lead, h('span.grow', c.name, c.sub ? h('span.model-sub', c.sub.slice(0, 90)) : null))),
          ])
        : h('div.hint', { style: { padding: '8px 10px' } }, kind ? `No ${KIND_LABEL[kind].toLowerCase()} match.` : 'Nothing matches. Agents, teams and skills show here.'),
    ),
  );
  paintActive();
  placeMenu(el, ta, start);
}

function paintActive() {
  if (!menu) return;
  const buttons = menu.el.querySelectorAll<HTMLElement>('.rt-menu-item');
  buttons.forEach((b, i) => b.classList.toggle('active', i === menu!.active));
  buttons[menu.active]?.scrollIntoView({ block: 'nearest' });
}

function pick(c: Candidate) {
  if (!menu) return;
  const { ta, start, onPick } = menu;
  const end = ta.selectionStart;
  const after = ta.value.slice(end);
  ta.setRangeText(`@${c.name}${/^\s/.test(after) ? '' : ' '}`, start, end, 'end');
  closeMenu();
  ta.dispatchEvent(new Event('input'));
  closeMenu(); // the input above may have reopened it on the new text
  onPick();
  ta.focus();
}

// Put the menu under the caret: measure where it is with a hidden copy of the textarea.
function placeMenu(el: HTMLElement, ta: HTMLTextAreaElement, pos: number) {
  const z = uiZoom();
  const cs = getComputedStyle(ta);
  const copy = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize'] as const) copy.style[p] = cs[p];
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  copy.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '@';
  copy.append(mark);
  document.body.append(copy);
  const x = mark.offsetLeft - ta.scrollLeft;
  const y = mark.offsetTop - ta.scrollTop + (parseFloat(cs.lineHeight) || 20);
  copy.remove();
  const r = ta.getBoundingClientRect();
  const w = 320;
  const left = Math.max(8, Math.min(r.left / z + x, window.innerWidth / z - w - 8));
  let top = r.top / z + Math.min(y, ta.clientHeight) + 4;
  const room = window.innerHeight / z - top;
  // no room below: open above the caret
  if (room < 220) top = Math.max(8, r.top / z + y - (parseFloat(cs.lineHeight) || 20) - Math.min(320, el.offsetHeight || 320) - 6);
  Object.assign(el.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, transform: 'none', zIndex: '96', width: `${w}px` });
}
