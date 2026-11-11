// A Markdown file read in a dialog. A very long one is drawn only where you are reading: the text is
// cut between its blocks (mdChunks) and just the pieces near the screen are in the page, so even a
// 100 MB file opens at once. Ctrl+F (⌘F) searches it (web/ui/find.tsx), since the browser's find only sees
// what is drawn.
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { h, md, mdChunks, modal } from '../core.ts';
import { useFind } from './find.tsx';
import { DomNode, mountReact } from './react.tsx';

/** From this size on a preview is drawn piece by piece. */
export const BIG_MARKDOWN = 150_000;
// a guess before a piece is on screen to be measured: about this many pixels for each character
const PX_PER_CHAR = 0.32;

type Chunks = ReturnType<typeof mdChunks>;

function Pieces({
  chunks,
  scroller,
  reveal,
}: {
  chunks: Chunks;
  scroller: () => HTMLElement | null;
  reveal: MutableRefObject<((i: number) => void) | null>;
}) {
  const pxOf = (i: number) => Math.max(80, chunks[i].raw.length * PX_PER_CHAR);
  const v = useVirtualizer({
    count: chunks.length,
    getScrollElement: scroller,
    estimateSize: pxOf,
    overscan: 2,
  });
  // (scrollToIndex() can only jump to a piece it has already measured, so scroll the box itself:
  //  the offset adds up the estimates, and whatever lands there is drawn and measured for real)
  reveal.current = (i) => {
    const el = scroller();
    if (!el) return;
    let top = 0;
    for (let n = 0; n < i; n++) top += pxOf(n);
    el.scrollTop = top;
  };
  return (
    <div className="md-window relative w-full" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((row) => (
        // (flow-root: the margins of its first and last block stay inside, so the measured height has them)
        <div
          key={row.key}
          ref={v.measureElement}
          data-index={row.index}
          className="absolute top-0 left-0 w-full flow-root"
          style={{ transform: `translateY(${row.start}px)` }}
        >
          <DomNode
            deps={[chunks, row.index]}
            make={() => {
              const part = chunks[row.index].render();
              part.classList.add('md-doc');
              // one document, not a stack of boxes: the padding is only at its ends
              part.style.paddingTop = row.index ? '0' : '';
              part.style.paddingBottom = row.index < chunks.length - 1 ? '0' : '';
              return part;
            }}
          />
        </div>
      ))}
    </div>
  );
}

function MarkdownDoc({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  // the dialog's body is what scrolls
  const body = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => void (body.current = host.current?.closest<HTMLElement>('.modal-body') ?? null), []);
  const big = text.length >= BIG_MARKDOWN;
  const chunks = useMemo(() => (big ? mdChunks(text) : []), [text, big]);
  const reveal = useRef<((i: number) => void) | null>(null);
  const find = useFind(
    body,
    big ? { count: chunks.length, text: (i) => chunks[i].raw, reveal: (i) => reveal.current?.(i) } : null,
  );
  return (
    <div ref={host}>
      {find}
      {big ? (
        <Pieces chunks={chunks} scroller={() => body.current} reveal={reveal} />
      ) : (
        <DomNode
          deps={[text]}
          make={() => {
            const doc = md(text);
            doc.classList.add('md-doc');
            return doc;
          }}
        />
      )}
    </div>
  );
}

/** Markdown, read in a dialog (sanitized by md()). */
export function showMarkdownDialog(name: string, text: string): void {
  const host = h('div');
  let view: { unmount: () => void } | null = null;
  // (unmounted after the closing animation, or the text would vanish first)
  const m = modal({ title: name, body: host, onClose: () => setTimeout(() => view?.unmount(), 600) });
  m.el.classList.add('doc');
  view = mountReact(host, <MarkdownDoc text={text} />);
}
