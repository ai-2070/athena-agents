// The shared controls' look, as utilities, so one component owns markup, behaviour and styling instead of a
// class string every caller has to remember. Both the React components and the plain-DOM factories
// (web/ui/dom.ts) build from these, and scripts/build-web.ts picks the names up from this file.
//
// The old names (btn, ghost, small, pill, ok, dot, busy, chip, badge, icon-btn) stay on the elements as bare
// hooks: nothing styles them any more, but tests and code look elements up by them, the same way the dock and
// the Station keep their markers. The look itself is in the utilities beside them.

/** What a caller may add to a control's classes (h()'s class attr allows null and false). */
type ClassName = string | null | false | undefined;

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'plain';
export type ButtonSize = 'default' | 'small' | 'tiny';

const BTN_BASE =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-ctl border font-medium whitespace-nowrap ' +
  '[transition:transform_0.18s_var(--ease-soft),background-color_0.15s,border-color_0.15s,color_0.15s,box-shadow_0.2s,opacity_0.2s] ' +
  'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none [&_.ico-svg]:m-[0_-2px_0_-3px]';

const BTN_SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-[13.5px] leading-none tracking-[-0.005em]',
  small: 'h-[30px] px-3 text-[13px] leading-none tracking-[-0.005em]',
  tiny: 'h-[26px] px-[9px] gap-1.5 text-[12px] leading-none tracking-[-0.005em]',
};

const BTN_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent border-[color-mix(in_srgb,var(--color-accent)_82%,var(--color-ink))] shadow-raised hover:bg-accent-hover',
  ghost:
    'bg-ghost text-ink border-line-2 shadow-raised ' +
    'hover:bg-ghost-hover hover:border-[color-mix(in_srgb,var(--color-ink)_22%,var(--color-line-2))]',
  danger:
    'bg-panel text-red border-[color-mix(in_srgb,var(--color-red)_38%,var(--color-line-2))] shadow-raised ' +
    'hover:bg-[color-mix(in_srgb,var(--color-red)_9%,var(--color-panel))] hover:border-[color-mix(in_srgb,var(--color-red)_60%,var(--color-line-2))]',
  plain: 'bg-transparent text-dim border-transparent shadow-none hover:bg-panel-2 hover:text-ink',
};

/** The classes for an action in the app's shared style. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'default', className: ClassName = '') {
  const markers = ['btn', variant !== 'primary' && variant, size !== 'default' && size];
  return [...markers, BTN_BASE, BTN_SIZES[size], BTN_VARIANTS[variant], className].filter(Boolean).join(' ');
}

/** Where an icon button sits: on the page, a quiet one, one inside a glass surface, or a small quiet
 *  action in a row of a panel. Each states its own border width, so one can be borderless. */
export type IconButtonVariant = 'default' | 'plain' | 'inset' | 'quiet';

const ICON_BTN_BASE = 'icon-btn inline-grid cursor-pointer place-items-center rounded-ctl ' +
  '[transition:transform_0.18s_var(--ease-soft),background-color_0.15s,border-color_0.15s,color_0.15s,box-shadow_0.2s,opacity_0.2s] ' +
  'hover:bg-panel-2 hover:text-ink active:scale-[0.96]';

const ICON_BTN_VARIANTS: Record<IconButtonVariant, string> = {
  default: 'size-[34px] border border-transparent bg-transparent text-icon',
  // inside a glass surface: quieter and a touch smaller
  plain: 'size-[26px] border border-transparent bg-transparent text-icon shadow-none',
  // inside a glass surface: a plate like the fields beside it
  inset: 'size-7 border border-line bg-panel text-icon shadow-raised',
  // a small, borderless action in a row of a panel (a team member's remove, a project's rename)
  quiet: 'size-7 border-0 bg-transparent text-dim',
};

/** The classes for an icon-only action. */
export function iconButtonClass(variant: IconButtonVariant = 'default', className: ClassName = '') {
  return [ICON_BTN_BASE, ICON_BTN_VARIANTS[variant], variant === 'plain' && 'plain', className].filter(Boolean).join(' ');
}

/** Where a field that opens something sits: on a page (`field`), or in a panel, where it stands in a
 *  row beside the app's other controls (`panel`). */
export type FieldTriggerKind = 'field' | 'panel';

/** The classes for a box you click to open something: a select's trigger, the agent picker. The shape of
 *  the app's fields, so a dropdown lines up with the text inputs beside it. */
export function fieldTriggerClass(kind: FieldTriggerKind = 'field', className: ClassName = '') {
  return [
    'field-trigger',
    'flex w-full cursor-pointer items-center gap-2.5 rounded-ctl border border-line-2 text-left outline-none focus-visible:border-accent data-popup-open:border-accent',
    kind === 'field' ? 'bg-bg px-3 py-2 text-[13.5px]' : 'h-9 bg-panel px-3 text-[13px]',
    className,
  ].filter(Boolean).join(' ');
}

/** A pill's tone, as the token its colour comes from. */
export type PillTone = 'dim' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';

export const PILL_TONES: Record<PillTone, string> = {
  dim: 'var(--color-dim)',
  ok: 'var(--color-ok)',
  warn: 'var(--color-amber)',
  bad: 'var(--color-red)',
  info: 'var(--color-ice)',
  accent: 'var(--color-accent)',
};

/** The tone name the old class carried (`.pill.ok` and friends), left on the element as a hook. */
const PILL_MARKERS: Record<PillTone, string> = { dim: '', ok: 'ok', warn: 'warn', bad: 'bad', info: 'info', accent: 'accent' };

/** A pill's classes. The tone is set on the element as `--tone` (see `pillStyle`). */
export function pillClass(tone: PillTone = 'dim', className: ClassName = '') {
  return [
    'pill',
    PILL_MARKERS[tone],
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] font-medium text-[12px] leading-[1.4] shadow-raised ' +
      'border-[color-mix(in_srgb,var(--tone)_22%,var(--color-line))] text-[var(--tone)] ' +
      'bg-[color-mix(in_srgb,var(--tone)_8%,transparent)]',
    className,
  ].filter(Boolean).join(' ');
}

/** The pill's tone as an inline custom property, which `pillClass` reads. */
export function pillStyle(tone: PillTone): { '--tone': string } {
  return { '--tone': PILL_TONES[tone] };
}

/** A small count or label on a quiet plate; `hot`: it wants you now. */
export function badgeClass(hot = false, className: ClassName = '') {
  return [
    'badge',
    hot && 'hot',
    'inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11.5px] leading-none tabular-nums shadow-raised',
    hot ? 'bg-amber font-semibold text-on-accent' : 'bg-panel-2 font-medium text-dim',
    className,
  ].filter(Boolean).join(' ');
}

/** A status light: gray at rest, green when on, amber when busy or waiting. `color` reads `--c`. */
export type DotTone = 'off' | 'on' | 'busy' | 'warn' | 'color';

/** A dot's classes. An empty tone (what a caller passes for "no state") is the resting grey, not nothing. */
export function dotClass(tone: DotTone | '' | null | undefined, className: ClassName = '') {
  return [DOT_CLASSES[tone || 'off'], className].filter(Boolean).join(' ');
}

const DOT_BASE = 'inline-block size-2 flex-none rounded-full';
const DOT_MARKERS: Record<DotTone, string> = { off: 'dot', on: 'dot on', busy: 'dot busy', warn: 'dot warn', color: 'st-dot' };
export const DOT_CLASSES: Record<DotTone, string> = {
  off: `${DOT_MARKERS.off} ${DOT_BASE} bg-line-2`,
  on: `${DOT_MARKERS.on} ${DOT_BASE} bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ok)_18%,transparent)]`,
  busy: `${DOT_MARKERS.busy} ${DOT_BASE} bg-amber animate-pulse`,
  warn: `${DOT_MARKERS.warn} ${DOT_BASE} bg-amber`,
  color: `${DOT_MARKERS.color} ${DOT_BASE} bg-[var(--c,var(--color-accent))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--c,var(--color-accent))_20%,transparent)]`,
};

/** A choice you turn on and off. */
export function chipClass(on = false, className: ClassName = '') {
  const look = on
    ? 'border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-line-2))] bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-panel))] text-accent'
    : 'border-line-2 bg-panel text-dim hover:bg-panel-2 hover:text-ink';
  return [
    'chip',
    on && 'on',
    'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] leading-[1.3] font-medium select-none shadow-raised ' +
      '[transition:transform_0.18s_var(--ease-soft),background-color_0.15s,border-color_0.15s,color_0.15s,box-shadow_0.2s,opacity_0.2s]',
    look,
    className,
  ].filter(Boolean).join(' ');
}

/** A row of chips. */
export const CHIPS_CLASS = 'chips flex flex-wrap gap-2';
