// A long chat draws only the messages near what you see (and a few around them), so a chat of
// thousands of messages scrolls and streams as lightly as a short one. Each message is measured once
// it has drawn; the ones not drawn keep their last height (or a guess), so the scrollbar stays right.
// Short chats draw every message as before (the browser's own Find still sees them all).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** From this many messages on, a chat draws only what is near the screen. */
export const WINDOW_FROM = 50;

export interface WindowedProps<T extends { id: string }> {
  items: readonly T[];
  /** the element that scrolls (the message list) */
  scroller: RefObject<HTMLElement | null>;
  /** start at the newest message (you were at the bottom) */
  atEnd: boolean;
  /** the space between messages, in px (the list's own gap) */
  gap: number;
  /** a guess at a message's height before it has drawn */
  estimate: number;
  render: (item: T) => ReactNode;
}

export function Windowed<T extends { id: string }>({ items, scroller, atEnd, gap, estimate, render }: WindowedProps<T>) {
  // (read once, when the list first draws)
  const startAtEnd = useRef(atEnd);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    getItemKey: useCallback((i: number) => items[i]?.id ?? i, [items]),
    gap,
    overscan: 6,
    // (far past the end: the browser stops it at the bottom, so the first draw is already the newest messages)
    initialOffset: () => (startAtEnd.current ? Number.MAX_SAFE_INTEGER : (scroller.current?.scrollTop ?? 0)),
  });
  // messages drawn before: drawn again (scrolled back to), they don't play their arrival animation
  const [seen] = useState(() => new Set<string>());
  return (
    <div className="msg-window" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((row) => {
        const item = items[row.index];
        if (!item) return null;
        return (
          <Row key={row.key} id={item.id} index={row.index} start={row.start} seen={seen} measure={v.measureElement}>
            {render(item)}
          </Row>
        );
      })}
    </div>
  );
}

function Row({ id, index, start, seen, measure, children }: { id: string; index: number; start: number; seen: Set<string>; measure: (el: Element | null) => void; children: ReactNode }) {
  const [again] = useState(() => seen.has(id));
  useEffect(() => void seen.add(id), [seen, id]);
  return (
    <div ref={measure} data-index={index} className={`msg-row${again ? ' again' : ''}`} style={{ transform: `translateY(${start}px)` }}>
      {children}
    </div>
  );
}
