// Controls on Base UI, drawn with the app's existing classes (.tabs, .seg, .chips) so they look the same
// as the plain-DOM ones while gaining keyboard use and the right roles for screen readers.
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import type { ReactNode } from 'react';

export interface Choice<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
}

const on = (yes: boolean, base = '') => [base, yes ? 'on' : ''].filter(Boolean).join(' ') || undefined;

/** A row of tabs and the panel of the open one. Arrow keys move between tabs. */
export function Tabs<V extends string>({ tabs, value, onChange, aside, children, label, rowClassName = '', panelClassName = '' }: {
  tabs: readonly Choice<V>[];
  value: V;
  onChange: (v: V) => void;
  /** Shown at the end of the tab row (the Library's "Runs on"). */
  aside?: ReactNode;
  /** The open tab's content. */
  children: ReactNode;
  label: string;
  rowClassName?: string;
  panelClassName?: string;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <div className={`row between ${rowClassName}`.trim()}>
        <BaseTabs.List className="tabs" aria-label={label}>
          {tabs.map((t) => (
            <BaseTabs.Tab key={t.value} value={t.value} title={t.title} className={(s) => on(s.active)}>
              {t.label}
            </BaseTabs.Tab>
          ))}
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
  return (
    <ToggleGroup className="seg" aria-label={label} value={value ? [value] : []} onValueChange={(v) => v[0] && onChange(v[0] as V)}>
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} title={o.title} className={(s) => on(s.pressed)}>
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
    <ToggleGroup className={`chips ${className}`.trim()} aria-label={label} value={[value]} onValueChange={(v) => v[0] !== undefined && onChange(v[0] as V)}>
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} title={o.title} className={(s) => on(s.pressed, 'chip')}>
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
