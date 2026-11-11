// The small marks that carry state around the app: a pill, a count, a status light and a chip.
// Their look lives in web/ui/classes.ts, so the plain-DOM factories in web/ui/dom.ts match them exactly.
import type { ComponentPropsWithoutRef, CSSProperties } from 'react';
import { badgeClass, chipClass, dotClass, pillClass, pillStyle } from './classes.ts';
import type { DotTone, PillTone } from './classes.ts';

export type { DotTone, PillTone } from './classes.ts';

/** A small state or label, in one of the tones. */
export function Pill({
  tone = 'dim',
  className = '',
  style,
  children,
  ...props
}: { tone?: PillTone } & ComponentPropsWithoutRef<'span'>) {
  return (
    <span className={pillClass(tone, className)} style={{ ...pillStyle(tone), ...style }} {...props}>
      {children}
    </span>
  );
}

/** A count or a very short word on a quiet plate. */
export function Badge({
  hot = false,
  className = '',
  children,
  ...props
}: { hot?: boolean } & ComponentPropsWithoutRef<'span'>) {
  return (
    <span className={badgeClass(hot, className)} {...props}>
      {children}
    </span>
  );
}

/** A status light: gray at rest, green when on, amber when busy or waiting. `color` reads `--c`. */
export function Dot({
  tone = 'off',
  className = '',
  style,
  ...props
}: { tone?: DotTone | '' } & Omit<ComponentPropsWithoutRef<'span'>, 'style'> & { style?: CSSProperties }) {
  return <span className={dotClass(tone, className)} style={style} aria-hidden="true" {...props} />;
}

/** Something you turn on and off. */
export function Chip({
  on = false,
  className = '',
  children,
  ...props
}: { on?: boolean } & ComponentPropsWithoutRef<'button'>) {
  return (
    <button type="button" className={chipClass(on, className)} {...props}>
      {children}
    </button>
  );
}
