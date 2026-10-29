// Ctrl+F (⌘F on a Mac) inside a chat or a Markdown preview: a small search box over the list you
// are reading, with the matches lit up and ↑ ↓ (Enter, Shift+Enter) to go from one to the next.
// The browser's own Find can't be used here: the desktop app has none, and a long chat or file is
// drawn only near the screen (web/chat/window.tsx), so most of it isn't in the page to find.
// A list that draws only part of itself says what all its items hold (FindItems) and how to scroll to one.
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from './react.tsx';
import { IconButton } from './button.tsx';

/** What a list that draws only the items near the screen lets the search know. Its drawn items are
 *  elements with data-index = the item's number. */
export interface FindItems {
  count: number;
  text: (i: number) => string;
  /** scroll so that item is drawn */
  reveal: (i: number) => void;
}

// ---------- finding ----------
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
const canHighlight = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/** Every place `query` is in the text drawn under `root` (case ignored). */
export function textRanges(root: Element, query: string): Range[] {
  const q = query.toLowerCase();
  const out: Range[] = [];
  if (!q) return out;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !SKIP.has(n.parentElement.tagName) && !n.parentElement.closest('[data-find-skip]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n as Text).data.toLowerCase();
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      out.push(r);
    }
  }
  return out;
}

/** How many times `query` is in `text` (case ignored). */
export function countIn(text: string, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let n = 0;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + q.length)) n++;
  return n;
}

// The look of the matches. It is added from here, not written in web/styles: the CSS optimizer
// does not know ::highlight() yet and warns on every build.
let styled = false;
function lookOfMatches(): void {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = '::highlight(find){background:color-mix(in srgb,var(--color-amber) 45%,transparent);color:inherit}::highlight(find-current){background:var(--color-accent);color:var(--color-on-accent)}';
  document.head.append(el);
}

function paint(all: Range[], current: Range | null): void {
  if (canHighlight()) {
    lookOfMatches();
    CSS.highlights.set('find', new Highlight(...all));
    if (current) CSS.highlights.set('find-current', new Highlight(current));
    else CSS.highlights.delete('find-current');
  } else if (current) {
    // (no highlights in this browser: the current one is selected)
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(current);
  }
}
function unpaint(): void {
  if (canHighlight()) {
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-current');
  }
}
/** Bring a match on screen, opening the closed <details> it is in. */
function show(r: Range): void {
  const el = r.startContainer.parentElement;
  for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  el?.scrollIntoView?.({ block: 'center' });
}

// ---------- which list Ctrl+F means ----------
interface Spot {
  scroller: RefObject<HTMLElement | null>;
  open: () => void;
}
const spots = new Set<Spot>();
let keyed = false;
let hovered: Spot | null = null;
const visible = (s: Spot) => {
  const el = s.scroller.current;
  return !!el && el.isConnected && !el.closest('.hidden, [hidden]');
};
/** The one Ctrl+F means: where you are typing, else under the pointer, else the one opened last (a dialog on top). */
function pick(): Spot | null {
  const live = [...spots].filter(visible);
  const at = document.activeElement;
  const inside = live.filter((s) => at && s.scroller.current!.parentElement?.contains(at));
  if (inside.length) return inside[inside.length - 1];
  if (hovered && live.includes(hovered)) return hovered;
  return live[live.length - 1] ?? null;
}
function listen(): void {
  if (keyed) return;
  keyed = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      const spot = pick();
      if (!spot) return;
      e.preventDefault();
      spot.open();
    },
    true,
  );
  document.addEventListener('pointerover', (e) => {
    const from = e.target instanceof Element ? e.target : null;
    hovered = [...spots].filter((s) => from && s.scroller.current?.parentElement?.contains(from)).pop() ?? null;
  });
}

/** Makes Ctrl+F search `scroller`'s list. Put the result in the component's output. `items`: for a list
 *  that draws only part of itself. */
export function useFind(scroller: RefObject<HTMLElement | null>, items?: FindItems | null) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const spot = useRef<Spot | null>(null);
  useEffect(() => {
    const s: Spot = {
      scroller,
      open: () => {
        setOpen(true);
        setFocus((n) => n + 1);
      },
    };
    spot.current = s;
    spots.add(s);
    listen();
    return () => void (spots.delete(s), hovered === s && (hovered = null));
  }, [scroller]);
  const close = useCallback(() => {
    setOpen(false);
    unpaint();
  }, []);
  const host = scroller.current?.parentElement;
  return open && host ? createPortal(<FindBar scroller={scroller} host={host} items={items ?? null} focus={focus} onClose={close} />, host) : null;
}

// ---------- the box ----------
type Hit = { item: number; nth: number };
const bar = 'glass absolute right-5 z-30 flex items-center gap-1 rounded-box py-1 pr-1 pl-2.5';

function FindBar({ scroller, host, items, focus, onClose }: { scroller: RefObject<HTMLElement | null>; host: HTMLElement; items: FindItems | null; focus: number; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(0);
  const [at, setAt] = useState(0);
  const [top, setTop] = useState(8);
  const input = useRef<HTMLInputElement>(null);
  // (read by the work below, which runs from timers and observers)
  const live = useRef({ query, items, at, total: 0, hits: [] as Hit[] });
  live.current = { ...live.current, query, items, at };

  // the box needs the host to be a place to put it in
  useEffect(() => {
    const was = host.style.position;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    setTop((scroller.current?.offsetTop ?? 0) + 8);
    return () => void (host.style.position = was);
  }, [host, scroller]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);
  useEffect(() => unpaint, []);

  /** where every match is, drawn or not; and, for the ones drawn, lit up */
  const look = useCallback((go: 'keep' | 'first' | number) => {
    const el = scroller.current;
    const { query: q, items: its } = live.current;
    if (!el) return;
    let n = 0;
    let cur = go === 'first' ? 0 : go === 'keep' ? live.current.at : go;
    let current: Range | null = null;
    const all = textRanges(el, q);
    if (its) {
      const hits: Hit[] = [];
      for (let i = 0; i < its.count; i++) for (let k = 0, c = countIn(its.text(i), q); k < c; k++) hits.push({ item: i, nth: k });
      live.current.hits = hits;
      n = hits.length;
      cur = Math.min(cur, Math.max(0, n - 1));
      const hit = hits[cur];
      if (hit) {
        const row = el.querySelector(`[data-index="${hit.item}"]`);
        const ranges = row ? textRanges(row, q) : [];
        current = ranges[Math.min(hit.nth, ranges.length - 1)] ?? null;
        if (!row && go !== 'keep') {
          // not drawn: scroll to it, then show it when it is
          its.reveal(hit.item);
          let tries = 0;
          const wait = () => {
            if (el.querySelector(`[data-index="${hit.item}"]`)) look(cur);
            else if (++tries < 30) requestAnimationFrame(wait);
          };
          requestAnimationFrame(wait);
        }
      }
    } else {
      n = all.length;
      cur = Math.min(cur, Math.max(0, n - 1));
      current = all[cur] ?? null;
    }
    setTotal(n);
    setAt(cur);
    live.current.at = cur;
    live.current.total = n;
    paint(all, current);
    if (current && go !== 'keep') show(current);
  }, [scroller]);

  useEffect(() => {
    // (typing waits a moment: a long chat is searched for each change)
    const t = setTimeout(() => look('first'), query ? 120 : 0);
    return () => clearTimeout(t);
  }, [query, look]);
  // the list changes under it: scrolling draws other items, an answer streams in
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const o = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => live.current.query && look('keep'), 100);
    });
    o.observe(el, { childList: true, subtree: true, characterData: true });
    return () => (o.disconnect(), clearTimeout(timer));
  }, [scroller, look]);

  // (from what the last search found, not the last drawing: Enter can come twice in a row)
  const step = (by: number) => live.current.total && look((live.current.at + by + live.current.total) % live.current.total);
  return (
    <div className={bar} style={{ top }} role="search" data-find-skip="">
      <input
        ref={input}
        className="h-7 w-44 border-0 bg-transparent p-0 text-[13px] outline-none"
        type="search"
        aria-label="Find in this chat"
        placeholder="Find…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // (and not the chat or dialog it is in)
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="min-w-12 text-center text-[12px] text-dim tabular-nums" aria-live="polite">
        {query ? (total ? `${at + 1} / ${total}` : 'None') : ''}
      </span>
      <IconButton type="button" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!total} onClick={() => step(-1)}>
        <Icon name="arrow-up" size={14} />
      </IconButton>
      <IconButton type="button" title="Next (Enter)" aria-label="Next match" disabled={!total} onClick={() => step(1)}>
        <Icon name="arrow-down" size={14} />
      </IconButton>
      <IconButton type="button" title="Close (Esc)" aria-label="Close find" onClick={onClose}>
        <Icon name="x" size={14} />
      </IconButton>
    </div>
  );
}
