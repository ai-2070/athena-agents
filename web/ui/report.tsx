// A dashboard line that heads a long report ("Delegated work … finished:" and the answers under it):
// the heading shows, the report opens under it. The agents still get the whole text.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { CollapseRoot, CollapseTrigger, CollapsePanel } from './collapse.tsx';
import { Icon } from './icon.tsx';

/** "Heading:\nreport" → the heading (without its colon) and the report; null for a plain line. */
export function splitReport(text: string): { heading: string; report: string } | null {
  const m = /^([^\n]*):\n+([\s\S]*\S[\s\S]*)$/.exec(text);
  return m ? { heading: `${m[1]}.`, report: m[2] } : null;
}

/** The heading in lineClass, a Show the report toggle, and the report (children) in a card when open. */
export function ReportLine({ heading, lineClass, children }: { heading: string; lineClass: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <CollapseRoot className="report-line flex flex-col items-center self-stretch" open={open} onOpenChange={setOpen}>
      <div className={lineClass}>{heading}</div>
      <CollapseTrigger className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] leading-[normal] font-medium text-faint transition-colors duration-200 ease-in-out hover:text-ink">
        <Icon name="chevron-down" size={12} className={`transition-transform duration-200 ease-in-out ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide the report' : 'Show the report'}
      </CollapseTrigger>
      <CollapsePanel className="w-full">
        <div className="mt-2 rounded-box border border-line bg-panel px-4 py-3 text-left">{children}</div>
      </CollapsePanel>
    </CollapseRoot>
  );
}
