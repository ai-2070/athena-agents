// Controls on Base UI, drawn with the app's existing classes (.tabs, .seg, .chips) so they look the same
// as the plain-DOM ones while gaining keyboard use and the right roles for screen readers.
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './react.tsx';
import { Plate } from './surface.tsx';
import { CHIPS_CLASS, chipClass } from './classes.ts';
import { slideSegment } from '../segmotion.ts';

export interface Choice<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
}

// The tab row's layout. :where() takes away its weight, so whatever a page passes in rowClassName
// (its own gap or alignment, say) wins over it.
const TAB_ROW = '[:where(&)]:flex [:where(&)]:flex-wrap [:where(&)]:items-center [:where(&)]:justify-between [:where(&)]:gap-2.5';

const on = (yes: boolean, base = '') => [base, yes ? 'on' : ''].filter(Boolean).join(' ') || undefined;

/** A row of tabs and the panel of the open one. Arrow keys move between tabs. */
export function Tabs<V extends string>({ tabs, value, onChange, aside, children, label, rowClassName = '', panelClassName = '' }: {
  tabs: readonly Choice<V>[];
  value: V;
  onChange: (v: V) => void;
  /** Shown at the end of the tab row (the Agent library's "Runs on"). */
  aside?: ReactNode;
  /** The open tab's content. */
  children: ReactNode;
  label: string;
  rowClassName?: string;
  panelClassName?: string;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <div className={`${TAB_ROW} ${rowClassName}`.trim()}>
        <BaseTabs.List className="tabs" aria-label={label}>
          {tabs.map((t) => (
            <BaseTabs.Tab key={t.value} value={t.value} title={t.title} className={(s) => on(s.active)}>
              {t.label}
            </BaseTabs.Tab>
          ))}
          <BaseTabs.Indicator className="tab-indicator" />
        </BaseTabs.List>
        {aside}
      </div>
      <BaseTabs.Panel value={value} className={panelClassName || undefined}>
        {children}
      </BaseTabs.Panel>
    </BaseTabs.Root>
  );
}

/** Pick one of a few (the plain-DOM seg()). Pressing the picked one again keeps it picked. */
export function Segmented<V extends string>({ options, value, onChange, label }: {
  options: readonly Choice<V>[];
  value: V | null;
  onChange: (v: V) => void;
  label: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const selected = root.current?.querySelector<HTMLButtonElement>('button.on') ?? null;
    slideSegment(previous.current, selected);
    previous.current = selected;
  }, [value, options]);
  return (
    <ToggleGroup ref={root} className="seg" aria-label={label} value={value ? [value] : []} onValueChange={(v) => v[0] && onChange(v[0] as V)}>
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} title={o.title} className={(s) => on(s.pressed)}>
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** An on/off switch with its text; clicking the text flips it too (the plain-DOM toggleRow()). */
export function Switch({ checked, onChange, children, className = '', disabled }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  /** What it turns on, read out with it. */
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch-row flex flex-wrap items-center gap-2.5 ${className}`.trim()}>
      <BaseSwitch.Root className="switch" checked={checked} onCheckedChange={(on) => onChange(on)} disabled={disabled}>
        <BaseSwitch.Thumb className="switch-thumb" />
      </BaseSwitch.Root>
      <span className="toggle-text cursor-pointer">{children}</span>
    </label>
  );
}

/** A labelled control with an optional hint under it (the plain-DOM field()). A group of buttons isn't
 *  labelable, so pass group to get a div named by its label instead of a <label>. */
export function Field({ label, hint, children, group }: { label: ReactNode; hint?: ReactNode; children: ReactNode; group?: string }) {
  if (group)
    return (
      <div className="field" role="group" aria-labelledby={group}>
        <span id={group}>{label}</span>
        {children}
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
    );
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Chips you turn on and off, any number at once (the plain-DOM chipSet()). */
export function ChipSet<V extends string>({ options, value, onChange, label }: {
  options: readonly Choice<V>[];
  value: readonly V[];
  onChange: (v: V[]) => void;
  label: string;
}) {
  return (
    <ToggleGroup multiple className={CHIPS_CLASS} aria-label={label} value={[...value]} onValueChange={(v) => onChange(v as V[])}>
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} title={o.title} className={(s) => chipClass(s.pressed)}>
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Filter chips where one is picked at a time; the first choice is usually "All". */
export function Chips<V extends string>({ options, value, onChange, label, className = '' }: {
  options: readonly Choice<V>[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup className={`${CHIPS_CLASS} ${className}`.trim()} aria-label={label} value={[value]} onValueChange={(v) => v[0] !== undefined && onChange(v[0] as V)}>
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} title={o.title} className={(s) => chipClass(s.pressed)}>
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

// ---------- Settings layout: sections of rows ----------
/** A column of settings sections, ten steps apart. */
export const Sections = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`flex flex-col gap-10 ${className}`.trim()}>{children}</div>;

/** A part of a settings page. Wide: its title and a line about it on the left, its controls in a bordered
 *  panel of rows on the right. Narrow: the title above the panel. bare: no panel (cards, or a list of its own). */
export function Section({ title, titleId, headingClassName = '', description, action, children, bare = false, className = '', id }: {
  title: ReactNode;
  titleId?: string;
  headingClassName?: string;
  description?: ReactNode;
  /** A button under the description (Connect, Add…). */
  action?: ReactNode;
  children: ReactNode;
  bare?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`settings-section grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-start gap-x-12 gap-y-4 max-lg:grid-cols-1 ${className}`.trim()}>
      <div className="min-w-0 lg:pt-1">
        <h2 id={titleId} className={`m-0 text-[15px] leading-snug font-semibold tracking-tight text-ink ${headingClassName}`.trim()}>
          {title}
        </h2>
        {description ? <p className="mt-1.5 mb-0 max-w-[44ch] text-[13px] leading-normal text-dim">{description}</p> : null}
        {action ? <div className="mt-3.5 flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {bare ? <div className="min-w-0">{children}</div> : <Plate className="panel min-w-0 divide-y divide-line rounded-box p-0">{children}</Plate>}
    </section>
  );
}

const ROW = 'set-row px-5 py-4';
/** One setting in a section's panel: its name and a line about it on the left, its control on the right
 *  (stack: under them, for a wide control). */
export function Row({ title, titleId, description, children, stack = false, className = '' }: { title: ReactNode; titleId?: string; description?: ReactNode; children?: ReactNode; stack?: boolean; className?: string }) {
  return (
    <div className={`${ROW} flex gap-x-8 gap-y-3 ${stack ? 'flex-col' : 'items-center max-sm:flex-col max-sm:items-stretch'} ${className}`.trim()}>
      <div className="min-w-0 flex-1">
        <span id={titleId} className="block text-[14px] leading-snug font-medium text-ink">
          {title}
        </span>
        {description ? <div className="mt-1 max-w-[62ch] text-[13px] leading-normal text-dim">{description}</div> : null}
      </div>
      {children ? <div className={stack ? 'min-w-0' : 'flex flex-none items-center gap-2 max-sm:flex-wrap'}>{children}</div> : null}
    </div>
  );
}

const FIELD_WIDTH = { sm: 'grid-cols-[minmax(0,1fr)_minmax(0,11rem)]', md: 'grid-cols-[minmax(0,1fr)_minmax(0,22rem)]', lg: 'grid-cols-[minmax(0,1fr)_minmax(0,32rem)]' } as const;
/** A labelled box as a row: the label (and its hint) on the left, the box on the right. Drawn like Field
 *  (label.field, its text the first span), so a label click focuses the box. stack: the box under the label.
 *  group: a div named by its label instead of a <label>, for a row of buttons. */
export function FieldRow({ label, hint, children, group, size = 'md', stack = false }: { label: ReactNode; hint?: ReactNode; children: ReactNode; group?: string; size?: keyof typeof FIELD_WIDTH; stack?: boolean }) {
  const grid = stack ? 'grid-cols-1 gap-y-3' : `${FIELD_WIDTH[size]} items-center gap-y-1 max-sm:grid-cols-1`;
  const cls = `field ${ROW} grid gap-x-8 ${grid}`;
  const inner = (
    <>
      <span id={group} className="col-start-1 row-start-1 text-[14px] leading-snug font-medium text-ink">
        {label}
      </span>
      {hint ? <span className={`hint col-start-1 row-start-2 max-w-[62ch] ${stack ? '' : 'max-sm:row-start-3'}`}>{hint}</span> : null}
      <div className={stack ? 'min-w-0' : `col-start-2 row-start-1 min-w-0 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-2 ${hint ? 'row-span-2' : ''}`}>{children}</div>
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-labelledby={group}>
      {inner}
    </div>
  ) : (
    <label className={cls}>{inner}</label>
  );
}

/** The buttons at the end of a panel (Save, Send test…), on the right. */
export const RowActions = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3.5">{children}</div>;

/** A quiet line of explanation at the end of a panel. */
export const PanelNote = ({ children }: { children: ReactNode }) => <div className="px-5 py-3.5 text-[13px] leading-normal text-dim [&_a]:text-accent">{children}</div>;

/** A switch as a row: its name on the left, the switch on the right, and a line about it under the name.
 *  The label is the Switch's own, so its text is just the name and a click on it flips it. */
export function SwitchRow({ checked, onChange, title, description, disabled }: { checked: boolean; onChange: (on: boolean) => void; title: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <div className={ROW}>
      <Switch className="w-full flex-row-reverse justify-between gap-6 text-[14px] leading-snug font-medium text-ink" checked={checked} onChange={onChange} disabled={disabled}>
        {title}
      </Switch>
      {description ? <div className="mt-1 max-w-[62ch] pr-16 text-[13px] leading-normal text-dim">{description}</div> : null}
    </div>
  );
}

/** The search box every list uses: a magnifier, the text, and a ✕ that clears it. className sizes the whole box. */
export function SearchBox({ value, onChange, placeholder, label, className = '', autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={`search-box relative min-w-0 ${className}`.trim()}>
      <Icon name="search" size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <input type="search" className="w-full py-2 pr-8 pl-9 text-[13.5px]" placeholder={placeholder} aria-label={label} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} />
      {value ? (
        <button type="button" className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent p-0 text-[11px] text-faint hover:bg-panel-2 hover:text-ink" aria-label="Clear the search" title="Clear" onClick={() => onChange('')}>
          ✕
        </button>
      ) : null}
    </div>
  );
}
