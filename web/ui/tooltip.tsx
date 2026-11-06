// A short label beside what the pointer is over (Base UI's Tooltip). The page draws it itself: the desktop app's web
// view doesn't show title attributes.
import { Tooltip as Base } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/** children: the element pointed at (one element; it takes the tooltip's handlers). */
export function Tooltip({ label, side = 'top', children }: { label: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }) {
  return (
    <Base.Root>
      <Base.Trigger render={children} delay={120} closeDelay={0} />
      <Base.Portal>
        <Base.Positioner side={side} sideOffset={8} collisionPadding={8} positionMethod="fixed" className="z-96 outline-none">
          <Base.Popup className="tooltip pointer-events-none max-w-72 rounded-ctl border border-line bg-raise px-2.5 py-1 text-[12px] leading-snug whitespace-nowrap text-ink shadow-pop [transition:opacity_0.12s,transform_0.12s] data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            {label}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
