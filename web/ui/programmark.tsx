// Program names share the same marks in settings and the installed-program list.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { presetIcon } from '../preseticons.ts';
import { programIcon } from '../programicons.ts';
import { onThemeChange } from '../theme.ts';
import { DomNode, Icon } from './react.tsx';
import { EveMark } from './evemark.tsx';

export function ProgramGlyph({ id, size = 17 }: { id: string; size?: number }) {
  const [theme, setTheme] = useState(0);
  useEffect(() => onThemeChange(() => setTheme((n) => n + 1)), []);
  if (id === 'eve') return <EveMark size={size} />;
  if (id === 'custom') return <Icon name="plug" size={size} />;
  return <span aria-hidden="true"><DomNode as="span" className="flex shrink-0" make={() => programIcon(id, id, size)} deps={[id, size, theme]} /></span>;
}

export function ProgramLabel({ id, children }: { id: string; children: ReactNode }) {
  return <span className="inline-flex items-center gap-3">
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-ctl bg-panel-2 text-ink">
      <ProgramGlyph id={id} />
    </span>
    <span>{children}</span>
  </span>;
}

export function PresetGlyph({ id, size = 17 }: { id: string; size?: number }) {
  const [theme, setTheme] = useState(0);
  useEffect(() => onThemeChange(() => setTheme((n) => n + 1)), []);
  return <span aria-hidden="true"><DomNode as="span" className="flex shrink-0" make={() => presetIcon(id, size)} deps={[id, size, theme]} /></span>;
}
