// The parts of a long dialog form (New project, New team): sections split by a hairline, each with a small icon
// tile and a title, and the dashed area files are dropped into.
import type { ReactNode } from 'react';
import { Icon } from './react.tsx';

/** One part of the form: its icon and title (a line under it, something at the end), then its fields. */
export function FormSection({ icon, title, hint, end, children, className = '' }: { icon: string; title: string; hint?: ReactNode; end?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-4 border-t border-line pt-6 first:border-t-0 first:pt-0 ${className}`.trim()}>
      <div className={`flex gap-3 ${hint ? 'items-start' : 'items-center'}`}>
        <span aria-hidden="true" className="grid size-8 flex-none place-items-center rounded-[9px] border border-line bg-panel-2 text-dim">
          <Icon name={icon} size={15} />
        </span>
        <div className={`min-w-0 flex-1 ${hint ? 'pt-px' : ''}`}>
          <h3 className="m-0 text-[14px] leading-snug font-semibold text-ink">{title}</h3>
          {hint ? <p className="m-0 mt-0.5 text-[12.5px] leading-normal text-dim">{hint}</p> : null}
        </div>
        {end ? <div className="flex flex-none items-center gap-2 pt-0.5">{end}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Where files go: what is already there, the Add files / folders button, and a line about dropping them anywhere. */
export function FileDrop({ children, picker, hint }: { children?: ReactNode; picker: ReactNode; hint: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-box border border-dashed border-line-2 bg-panel-2/40 px-4 py-3.5">
      {children}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {picker}
        <span className="min-w-0 flex-1 basis-56 text-[12.5px] leading-normal text-dim">{hint}</span>
      </div>
    </div>
  );
}
