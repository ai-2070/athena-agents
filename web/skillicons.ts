// Draws a skill's mark (shared/skillmarks.ts): a picture, a brand logo or a line icon.
// A skill without one of its own (one you wrote) keeps the puzzle piece.
import { icon, logo } from './icons.ts';
import { craftIconSrc } from './crafticons.ts';
import { SKILL_MARKS } from '../shared/skillmarks.ts';
import type { SkillMarkSpec } from '../shared/skillmarks.ts';

/** What a skill is drawn with. A skill without a mark of its own is the puzzle piece. */
export function skillMark(slug: string | null | undefined): SkillMarkSpec {
  const id = String(slug || '');
  const craft = craftIconSrc(id);
  if (craft) return { img: craft, craft: true };
  return Object.hasOwn(SKILL_MARKS, id) ? SKILL_MARKS[id] : { icon: 'puzzle' };
}

/** True when the mark carries its own colours (a picture, a logo, a coloured icon), so it sits on a plain tile rather than the accent one. */
export const ownColours = (m: SkillMarkSpec): boolean => !('icon' in m) || !!m.color;

/** The skill's mark as an element, for plain DOM (chips, mention lists). */
export function skillIcon(slug: string | null | undefined, size = 16): Element {
  const m = skillMark(slug);
  if ('img' in m) {
    const img = document.createElement('img');
    img.src = m.img;
    img.width = size;
    img.height = size;
    img.alt = '';
    img.draggable = false;
    img.className = 'skill-mark-img flex-none';
    img.style.borderRadius = `${Math.max(3, Math.round(size * 0.24))}px`;
    if (m.tile) Object.assign(img.style, { background: m.tile, padding: `${Math.max(1, Math.round(size * 0.12))}px`, boxSizing: 'border-box' });
    return img;
  }
  if ('logo' in m) return logo(m.logo, size) || icon('puzzle', size);
  const svg = icon(m.icon, size);
  if (m.color) svg.style.color = m.color;
  return svg;
}
