// A skill's mark in its tile: on the Skills page, in the skill pickers and the Import and History lists.
import { useEffect, useState } from 'react';
import { onThemeChange } from './theme.ts';
import { ownColours, skillIcon, skillMark } from './skillicons.ts';
import { DomNode } from './ui/react.tsx';

const TILE = { lg: 'size-10 rounded-[10px]', md: 'size-9 rounded-[9px]', sm: 'size-7 rounded-[8px]' } as const;
const GLYPH = { lg: 20, md: 17, sm: 14 } as const;

export function SkillMark({ slug, size = 'lg' }: { slug: string; size?: keyof typeof TILE }) {
  // logos pick their ink for the page (GitHub is near-black), so redraw when the theme changes
  const [theme, setTheme] = useState(0);
  useEffect(() => onThemeChange(() => setTheme((n) => n + 1)), []);
  const m = skillMark(slug);
  if ('img' in m) {
    // the app's own icon fills the tile; a light mark (ComfyUI's yellow) sits on its dark square
    return (
      <img
        className={`skill-ico ${m.craft ? 'craft-icon ' : ''}flex-none ${TILE[size]}`}
        style={m.tile ? { background: m.tile, padding: size === 'sm' ? 3 : 5 } : undefined}
        src={m.img}
        alt=""
        draggable={false}
      />
    );
  }
  const plain = ownColours(m);
  return (
    <span
      aria-hidden="true"
      className={`skill-ico flex-none ${TILE[size]}${plain ? ' border border-line bg-panel-2 text-ink' : ''}`}
    >
      <DomNode as="span" className="flex" make={() => skillIcon(slug, GLYPH[size])} deps={[slug, size, theme]} />
    </span>
  );
}
