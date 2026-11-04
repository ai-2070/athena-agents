// Shared non-modal Base UI popover surface and positioning for anchored pickers. Fixed, so a popup near the
// bottom never makes the page scroll further.
import { Popover } from '@base-ui/react/popover';
import { forwardRef } from 'react';
import type { ReactNode } from 'react';

export const PopoverRoot = Popover.Root;

export const PopoverContent = forwardRef<HTMLDivElement, Omit<Popover.Popup.Props, 'className'> & {
  className?: string;
  positioner?: Omit<Popover.Positioner.Props, 'className'>;
  children?: ReactNode;
}>(function PopoverContent({ positioner, className = '', children, ...popup }, ref) {
  return (
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} positionMethod="fixed" {...positioner} className="z-96 outline-none">
        <Popover.Popup {...popup} ref={ref} className={`st-menu dd static ${className}`.trim()}>{children}</Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
});
