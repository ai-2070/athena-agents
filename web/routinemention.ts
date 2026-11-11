// The "@" menu in a routine's text: type @ (or use the Agent / Team / Skill buttons) and pick who does it
// or which skill to use. Plain DOM on a textarea: the menu follows the caret.
import { h, mount } from './core.ts';
import type { Child } from './core.ts';
import { uiZoom } from './look.ts';
import { openMentionPopup } from './routinementionmenu.tsx';
import type { MentionPopup } from './routinementionmenu.tsx';
import { mentionQuery } from '../shared/routines.ts';
import type { RoutineMention, RoutineMentionKind } from '../shared/types.ts';

/** Something a routine can mention, as the menu shows it. */
export interface Candidate extends RoutineMention {
  lead: Child;
  sub: string;
  color?: string;
}

export const KIND_LABEL: Record<RoutineMentionKind, string> = { agent: 'Agents', team: 'Teams', skill: 'Skills' };

interface MenuState {
  el: HTMLElement | null;
  popup: MentionPopup | null;
  id: string;
  aria: Map<string, string | null>;
  ta: HTMLTextAreaElement;
  start: number;
  kind: RoutineMentionKind | null;
  items: Candidate[];
  active: number;
  onPick: () => void;
  candidates: () => Candidate[];
}
let menu: MenuState | null = null;
let nextMenuId = 0;
const mentionAria = ['aria-autocomplete', 'aria-controls', 'aria-activedescendant'] as const;

/** True while the @ menu is open for this box: its arrows, Enter, Tab and Escape are the menu's. */
export const mentionMenuOpen = (ta: HTMLTextAreaElement): boolean => menu?.ta === ta;

export function closeMenu(): void {
  const current = menu;
  menu = null;
  if (current) {
    for (const [name, value] of current.aria) {
      if (value === null) current.ta.removeAttribute(name);
      else current.ta.setAttribute(name, value);
    }
  }
  current?.popup?.close();
}

/** Watches a textarea for "@…" and offers what it can mention. Returns how to stop. */
export function attachMentions(ta: HTMLTextAreaElement, candidates: () => Candidate[], onPick: () => void): () => void {
  const update = () => {
    const q = mentionQuery(ta.value, ta.selectionStart);
    if (!q || ta.selectionStart !== ta.selectionEnd) return closeMenu();
    openMenu(ta, q.start, q.query, menu?.ta === ta && menu.start === q.start ? menu.kind : null, onPick, candidates);
  };
  const blur = () => setTimeout(() => menu?.ta === ta && document.activeElement !== ta && closeMenu(), 150);
  const keydown = (e: KeyboardEvent) => {
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
  };
  ta.addEventListener('input', update);
  ta.addEventListener('click', update);
  ta.addEventListener('blur', blur);
  ta.addEventListener('keydown', keydown);
  return () => {
    ta.removeEventListener('input', update);
    ta.removeEventListener('click', update);
    ta.removeEventListener('blur', blur);
    ta.removeEventListener('keydown', keydown);
    if (menu?.ta === ta) closeMenu();
  };
}

/** The toolbar buttons: put an "@" at the caret and show only that kind. */
/** Puts text in place of start..end, caret after it, and says so the way typing does (so a React page
 *  hears it: its own value setter is skipped, and the event bubbles to where React listens). */
function replaceText(ta: HTMLTextAreaElement, text: string, start: number, end: number): void {
  const value = ta.value.slice(0, start) + text + ta.value.slice(end);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
  ta.setSelectionRange(start + text.length, start + text.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export function startMention(ta: HTMLTextAreaElement, kind: RoutineMentionKind): void {
  ta.focus();
  const at = ta.selectionStart;
  const before = ta.value.slice(0, at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  replaceText(ta, `${lead}@`, at, ta.selectionEnd);
  if (menu?.ta === ta) openMenu(ta, menu.start, '', kind, menu.onPick, menu.candidates);
}

function openMenu(
  ta: HTMLTextAreaElement,
  start: number,
  query: string,
  kind: RoutineMentionKind | null,
  onPick: () => void,
  candidates: () => Candidate[],
) {
  const q = query.toLowerCase().trim();
  const all = candidates().filter((c) => !kind || c.kind === kind);
  // names that start with what you typed first, then names that contain it
  const items = [
    ...all.filter((c) => c.name.toLowerCase().startsWith(q)),
    ...all.filter((c) => q && !c.name.toLowerCase().startsWith(q) && `${c.name} ${c.sub}`.toLowerCase().includes(q)),
  ].slice(0, 30);
  if (!items.length && q.includes(' ')) return closeMenu(); // typing on past a name: not a mention
  if (menu && menu.ta !== ta) closeMenu();
  const groups = (['agent', 'team', 'skill'] as const)
    .map((k) => ({ k, list: items.filter((c) => c.kind === k) }))
    .filter((g) => g.list.length);
  // The order on screen is the order for the arrow keys.
  const ordered = groups.flatMap((g) => g.list);
  if (menu) {
    Object.assign(menu, { start, kind, items: ordered, active: 0, onPick, candidates });
  } else {
    const id = `routine-mention-${++nextMenuId}`;
    const aria = new Map<string, string | null>(mentionAria.map((name) => [name, ta.getAttribute(name)]));
    ta.setAttribute('aria-autocomplete', 'list');
    ta.setAttribute('aria-controls', id);
    menu = { el: null, popup: null, id, aria, ta, start, kind, items: ordered, active: 0, onPick, candidates };
    const state = menu;
    state.popup = openMentionPopup(
      ta,
      id,
      () => caretRect(ta, state.start),
      (el) => {
        if (menu !== state) return;
        state.el = el;
        paintMenu();
      },
      () => {
        if (menu === state) closeMenu();
      },
    );
  }
  paintMenu();
  menu?.popup?.update();
}

function paintMenu() {
  if (!menu?.el) return;
  const { el, kind, items } = menu;
  const groups = (['agent', 'team', 'skill'] as const)
    .map((k) => ({ k, list: items.filter((c) => c.kind === k) }))
    .filter((g) => g.list.length);
  mount(
    el,
    h('div.st-menu-head', kind ? `Mention ${KIND_LABEL[kind].slice(0, -1).toLowerCase()}` : 'Mention'),
    h(
      'div.model-list',
      { class: 'max-h-[280px]' },
      groups.length
        ? groups.map((g) => [
            groups.length > 1 || !kind
              ? h(
                  'div',
                  { class: 'px-2.5 pt-2.5 pb-1 text-[12px] leading-[normal] font-medium text-faint' },
                  KIND_LABEL[g.k],
                )
              : null,
            g.list.map((c) =>
              h(
                'button.st-menu-item.rt-menu-item',
                {
                  class: '[&.active]:bg-panel-2 [&.active]:text-accent [&.active_.ico-svg]:text-accent',
                  type: 'button',
                  onclick: () => pick(c),
                },
                c.lead,
                h('span', { class: 'min-w-0 flex-1' }, c.name, c.sub ? h('span.model-sub', c.sub.slice(0, 90)) : null),
              ),
            ),
          ])
        : h(
            'div.hint',
            { style: { padding: '8px 10px' } },
            kind
              ? `No ${KIND_LABEL[kind].toLowerCase()} match.`
              : 'Nothing matches. Agents, teams and skills show here.',
          ),
    ),
  );
  paintActive();
}

function paintActive() {
  if (!menu?.el) return;
  const buttons = menu.el.querySelectorAll<HTMLElement>('.rt-menu-item');
  buttons.forEach((b, i) => {
    b.classList.toggle('active', i === menu!.active);
    b.id = `${menu!.id}-option-${i}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === menu!.active));
  });
  if (buttons[menu.active]) menu.ta.setAttribute('aria-activedescendant', buttons[menu.active].id);
  else menu.ta.removeAttribute('aria-activedescendant');
  buttons[menu.active]?.scrollIntoView({ block: 'nearest' });
}

function pick(c: Candidate) {
  if (!menu) return;
  const { ta, start, onPick } = menu;
  const end = ta.selectionStart;
  const after = ta.value.slice(end);
  closeMenu();
  replaceText(ta, `@${c.name}${/^\s/.test(after) ? '' : ' '}`, start, end);
  closeMenu(); // the input above may have reopened it on the new text
  onPick();
  ta.focus();
}

// Put the menu under the caret: measure where it is with a hidden copy of the textarea.
function caretRect(input: HTMLTextAreaElement, pos: number): DOMRect {
  const z = uiZoom();
  // with mentions shown as pills the textarea is hidden and the editor after it is what you see
  const shown = input.nextElementSibling;
  const ta =
    input.hidden && shown instanceof HTMLElement && shown.getAttribute('contenteditable') === 'true' ? shown : input;
  const cs = getComputedStyle(ta);
  const copy = document.createElement('div');
  for (const p of [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderStyle',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
  ] as const)
    copy.style[p] = cs[p];
  Object.assign(copy.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  copy.textContent = input.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '@';
  copy.append(mark);
  document.body.append(copy);
  const x = mark.offsetLeft - ta.scrollLeft;
  const y = mark.offsetTop - ta.scrollTop + (parseFloat(cs.lineHeight) || 20);
  copy.remove();
  const r = ta.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight) || 20;
  const bottom = r.top + Math.min(y, ta.clientHeight) * z;
  return new DOMRect(r.left + x * z, bottom - lineHeight * z, 0, lineHeight * z);
}
