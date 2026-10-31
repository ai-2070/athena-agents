// The plain-DOM side of the app's shared controls. A page that builds its own markup gets the same button,
// pill, badge, dot and chip as the React components, from the same classes (web/ui/classes.ts).
// (ui/classes.ts is a leaf, so this module and core.ts can both use it without a cycle.)
import { h } from '../core.ts';
import type { Attrs, Child } from '../core.ts';
import { badgeClass, buttonClass, chipClass, dotClass, iconButtonClass, pillClass, pillStyle } from './classes.ts';
import type { ButtonSize, ButtonVariant, DotTone, IconButtonVariant, PillTone } from './classes.ts';

// (no Omit<> on the attrs: an index signature in the Attrs type would swallow the handler types)
type ButtonAttrs = Attrs<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

/** A button in the app's shared style. */
export function domButton({ variant, size, class: cls, ...attrs }: ButtonAttrs = {}, ...children: Child[]): HTMLButtonElement {
  return h('button', { ...attrs, class: buttonClass(variant, size, cls) }, ...children);
}

/** A link that looks like a button. */
export function domButtonLink({ variant, size, class: cls, ...attrs }: Attrs<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }, ...children: Child[]): HTMLAnchorElement {
  return h('a', { ...attrs, class: buttonClass(variant, size, cls) }, ...children);
}

/** An icon-only button. Give it a title or an aria-label. */
export function domIconButton({ variant, class: cls, ...attrs }: Attrs<HTMLButtonElement> & { variant?: IconButtonVariant } = {}, child?: Child): HTMLButtonElement {
  return h('button', { ...attrs, class: iconButtonClass(variant, cls) }, child);
}

/** A small state or label. */
export function domPill(tone: PillTone = 'dim', { class: cls, ...attrs }: Attrs<HTMLSpanElement> = {}, ...children: Child[]): HTMLSpanElement {
  return h('span', { ...attrs, class: pillClass(tone, cls), style: { ...pillStyle(tone), ...(attrs.style as object | undefined) } }, ...children);
}

/** A count or a very short word. */
export function domBadge({ hot, class: cls, ...attrs }: Attrs<HTMLSpanElement> & { hot?: boolean } = {}, ...children: Child[]): HTMLSpanElement {
  return h('span', { ...attrs, class: badgeClass(!!hot, cls) }, ...children);
}

/** A status light. */
export function domDot(tone: DotTone | '' | null | undefined = 'off', attrs: Attrs<HTMLSpanElement> = {}): HTMLSpanElement {
  const { class: cls, ...rest } = attrs;
  return h('span', { ...rest, class: dotClass(tone, cls), 'aria-hidden': 'true' });
}

/** A choice you turn on and off. */
export function domChip(on: boolean, { class: cls, ...attrs }: Attrs<HTMLButtonElement> = {}, ...children: Child[]): HTMLButtonElement {
  return h('button', { type: 'button', ...attrs, class: chipClass(on, cls) }, ...children);
}
