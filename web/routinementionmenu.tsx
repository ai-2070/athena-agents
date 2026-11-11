// A React host for the textarea's plain-DOM mention choices.
import { flushSync } from 'react-dom';
import { createAppRoot } from './ui/root.tsx';
import { PopoverContent, PopoverRoot } from './ui/popover.tsx';

export interface MentionPopup {
  update(): void;
  close(): void;
}

export function openMentionPopup(
  ta: HTMLTextAreaElement,
  id: string,
  caret: () => DOMRect,
  ready: (el: HTMLElement) => void,
  dismiss: () => void,
): MentionPopup {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createAppRoot(host);
  let open = true;
  let disposed = false;
  let exitTimer: number | undefined;
  const ref = (el: HTMLDivElement | null) => {
    if (el) ready(el);
  };
  const dispose = () => {
    if (open || disposed) return;
    disposed = true;
    window.clearTimeout(exitTimer);
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  const draw = () =>
    root.render(
      <PopoverRoot
        open={open}
        onOpenChange={(next, details) => {
          if (next) return;
          // Dismissal follows the textarea's existing blur and key handlers, not popup focus.
          if (details.reason === 'escape-key' || details.reason === 'outside-press' || details.reason === 'focus-out') {
            details.cancel();
            return;
          }
          dismiss();
        }}
        onOpenChangeComplete={(next) => {
          if (!next) dispose();
        }}
      >
        <PopoverContent
          positioner={{
            anchor: { getBoundingClientRect: caret, contextElement: ta },
            positionMethod: 'fixed',
            sideOffset: 4,
          }}
          ref={ref}
          id={id}
          role="listbox"
          aria-label="Mention"
          initialFocus={false}
          finalFocus={false}
          onMouseDown={(event) => event.preventDefault()}
          className="skp-menu rt-menu w-[300px] max-w-[300px] data-[ending-style]:pointer-events-none"
        />
      </PopoverRoot>,
    );
  flushSync(draw);
  return {
    update: () => {
      if (open) flushSync(draw);
    },
    close: () => {
      if (open) {
        open = false;
        exitTimer = window.setTimeout(dispose, 500);
        draw();
      }
    },
  };
}
