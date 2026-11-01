// Shared opening and closing motion for inline panels.
import { Collapsible } from '@base-ui/react/collapsible';
import type { ReactNode } from 'react';

export const CollapseRoot = Collapsible.Root;
export const CollapseTrigger = Collapsible.Trigger;

export function CollapsePanel({ children, id, className = '', keepMounted = false }: { children: ReactNode; id?: string; className?: string; keepMounted?: boolean }) {
  return <Collapsible.Panel id={id} keepMounted={keepMounted} className={`h-(--collapsible-panel-height) overflow-hidden [transition:height_240ms_ease-in-out,opacity_240ms_ease-in-out] data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none in-[.reduce-motion]:transition-none ${className}`.trim()}>{children}</Collapsible.Panel>;
}
