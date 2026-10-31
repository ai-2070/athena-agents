// The Station's colours for what CSS can't reach: the three.js map and the pictures drawn on canvases (monitors, the
// team symbols). Everything is worked out from the page's own tokens (--color-*) for light or dark, once, and again only
// when the system switches theme or Settings > Appearance changes the accent: never per frame. The labels, buttons and panels
// around the map use the tokens in CSS and follow by themselves.
import * as THREE from 'three';
import { isDark, onThemeChange, themeColor } from '../theme.ts';

/** A brand that is plain black or white (X, Codex, GitHub…) takes the page's text colour: dark on white, light on black. */
export const INK = 'var(--color-ink)';

type Rgb = [number, number, number];
const probe = new THREE.Color();
function parse(css: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  probe.set(css);
  return [Math.round(probe.r * 255), Math.round(probe.g * 255), Math.round(probe.b * 255)];
}
const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` with `t` (0 to 1) of `b` mixed in, as #rrggbb. Mixed in sRGB, like color-mix() in the stylesheet. */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
/** A #rrggbb colour with an opacity, for a canvas gradient stop. */
export const alpha = (c: string, a: number): string => `${c}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')}`;
const num = (css: string): number => parseInt(hex(parse(css)).slice(1), 16);
const luma = (css: string): number => {
  const [r, g, b] = parse(css);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** What the Station draws with now. Filled in by refreshPalette(); read it where something is built or drawn, never keep a copy. */
export interface StationPalette {
  dark: boolean;
  // the page's colours, as CSS (canvases, styles set from script)
  ink: string;
  dim: string;
  faint: string;
  line: string;
  line2: string;
  bg: string;
  floor: string;
  raise: string;
  accent: string;
  onAccent: string;
  amber: string;
  red: string;
  ok: string;
  // the map's scene
  clear: number;
  ambient: number;
  ambientK: number;
  sun: number;
  sunK: number;
  rim: number;
  rimK: number;
  dots: number;
  /** how soft glows go on the map: added up in the dark, laid on normally in the light (added light would vanish on white) */
  blend: THREE.Blending;
  /** how strong a glow shows (its own opacity times this) */
  glowK: number;
  /** how strong the dashed wires from the header show, as a share of the dark map's */
  wireK: number;
  /** the brain's lamp, and what its pulses can add, as a share of the dark map's */
  lampK: number;
  // surfaces of the map: a team platform's side and top (the team's colour is mixed in), the Brain's base, the bench, desk parts
  podSide: string;
  podTop: string;
  base: string;
  baseEdge: string;
  benchTop: string;
  benchEdge: string;
  desk: string;
  deskLeg: string;
  frame: string;
  chair: string;
  head: string;
  /** muted lines: the spokes and links between things, and the shadow under platforms */
  wire: string;
  shadow: string;
  // status lights and rings
  idle: THREE.Color;
  working: THREE.Color;
  waiting: THREE.Color;
  failed: THREE.Color;
  done: THREE.Color;
  lead: THREE.Color;
  /** what pulses of light running between things are drawn in */
  pulse: THREE.Color;
  // the Brain's globe
  globeA: THREE.Color;
  globeB: THREE.Color;
  halo: THREE.Color;
  beam: THREE.Color;
  star: THREE.Color;
  lamp: THREE.Color;
  // the monitors on the desks (canvas colours)
  screen: {
    idleBg: string;
    idleBar: string;
    idleTitle: string;
    idleDim: string;
    idleLine: string;
    needsBg: string;
    needsHi: string;
    needsLo: string;
    needsTitle: string;
    needsText: string;
    needsDim: string;
    workBg: string;
    workDisc: string;
    workTitle: string;
    workDim: string;
    workTrack: string;
  };
  /** the disc behind a team's symbol, and its edge and glyph colours get the team's own */
  disc: string;
}

const FALLBACK = { ink: '#1a1a1f', dim: '#5b5b66', faint: '#747480', line: '#ebebef', 'line-2': '#dcdce3', bg: '#ffffff', floor: '#f3f3f6', raise: '#ffffff', accent: '#18688e', 'on-accent': '#ffffff', amber: '#b4690e', red: '#d3303f', ok: '#1c8a53' };
const get = (name: keyof typeof FALLBACK): string => themeColor(name, FALLBACK[name]);

export const pal: StationPalette = {
  dark: false,
  ink: '',
  dim: '',
  faint: '',
  line: '',
  line2: '',
  bg: '',
  floor: '',
  raise: '',
  accent: '',
  onAccent: '',
  amber: '',
  red: '',
  ok: '',
  clear: 0,
  ambient: 0,
  ambientK: 0,
  sun: 0,
  sunK: 0,
  rim: 0,
  rimK: 0,
  dots: 0,
  blend: THREE.NormalBlending,
  glowK: 1,
  wireK: 1,
  lampK: 1,
  podSide: '',
  podTop: '',
  base: '',
  baseEdge: '',
  benchTop: '',
  benchEdge: '',
  desk: '',
  deskLeg: '',
  frame: '',
  chair: '',
  head: '',
  wire: '',
  shadow: '',
  idle: new THREE.Color(),
  working: new THREE.Color(),
  waiting: new THREE.Color(),
  failed: new THREE.Color(),
  done: new THREE.Color(),
  lead: new THREE.Color(),
  pulse: new THREE.Color(),
  globeA: new THREE.Color(),
  globeB: new THREE.Color(),
  halo: new THREE.Color(),
  beam: new THREE.Color(),
  star: new THREE.Color(),
  lamp: new THREE.Color(),
  screen: { idleBg: '', idleBar: '', idleTitle: '', idleDim: '', idleLine: '', needsBg: '', needsHi: '', needsLo: '', needsTitle: '', needsText: '', needsDim: '', workBg: '', workDisc: '', workTitle: '', workDim: '', workTrack: '' },
  disc: '',
};

const toneCache = new Map<string, string>();
const mutedCache = new Map<string, string>();

/** Everything that decides how the palette looks, as one string: a change in it means the map must be restyled. */
function key(): string {
  return [isDark(), ...(['ink', 'bg', 'floor', 'line-2', 'accent', 'amber', 'red', 'ok'] as const).map(get)].join('|');
}

let shown = '';
/** Reads the page's colours now and works the map's out from them. */
export function refreshPalette(): void {
  const dark = isDark();
  shown = key();
  toneCache.clear();
  mutedCache.clear();
  pal.dark = dark;
  pal.ink = get('ink');
  pal.dim = get('dim');
  pal.faint = get('faint');
  pal.line = get('line');
  pal.line2 = get('line-2');
  pal.bg = get('bg');
  pal.floor = get('floor');
  pal.raise = get('raise');
  pal.accent = get('accent');
  pal.onAccent = get('on-accent');
  pal.amber = get('amber');
  pal.red = get('red');
  pal.ok = get('ok');
  const { ink, floor, accent, amber, red, ok } = pal;
  pal.clear = num(floor);
  pal.blend = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  if (dark) {
    pal.ambient = 0xbfc8ff;
    pal.ambientK = 0.55;
    pal.sun = 0xffffff;
    pal.sunK = 1.1;
    pal.rim = 0x7fb6ff;
    pal.rimK = 0.35;
    pal.dots = num(mix(floor, ink, 0.13));
    pal.glowK = 0.85;
    pal.wireK = 1;
    pal.lampK = 1;
    pal.podSide = pal.podTop = '';
    pal.base = mix(floor, ink, 0.06);
    pal.baseEdge = mix(accent, floor, 0.35);
    pal.benchTop = mix(floor, ink, 0.1);
    pal.benchEdge = mix(floor, ink, 0.3);
    pal.desk = mix(floor, ink, 0.14);
    pal.deskLeg = mix(floor, ink, 0.08);
    pal.frame = mix(floor, ink, 0.03);
    pal.chair = pal.deskLeg;
    pal.head = mix(floor, ink, 0.9);
    pal.wire = mix(floor, ink, 0.5);
    pal.shadow = floor;
    pal.idle.set(mix(floor, ink, 0.34));
    pal.pulse.set(mix(accent, '#ffffff', 0.6));
    pal.globeA.set(mix(accent, '#ffffff', 0.15));
    pal.globeB.set(mix(accent, '#ffffff', 0.8));
    pal.halo.set(accent);
    pal.beam.set(mix(amber, '#ffffff', 0.25));
    pal.star.set(amber);
    pal.lamp.set(mix(accent, '#ffffff', 0.4));
    pal.disc = mix(floor, ink, 0.05);
  } else {
    pal.ambient = 0xffffff;
    pal.ambientK = 1.55;
    pal.sun = 0xfffaf2;
    pal.sunK = 2.1;
    pal.rim = 0xe4e8ff;
    pal.rimK = 0.4;
    pal.dots = num(mix(floor, pal.line2, 0.75));
    pal.glowK = 0.5;
    pal.wireK = 1.5;
    pal.lampK = 0.25;
    pal.podSide = '#e8e8ee';
    pal.podTop = '#fafafc';
    pal.base = '#ececf1';
    pal.baseEdge = mix(floor, ink, 0.4);
    pal.benchTop = '#f6f6f9';
    pal.benchEdge = mix(floor, ink, 0.2);
    pal.desk = '#ffffff';
    pal.deskLeg = '#dedee5';
    pal.frame = '#cfcfd8';
    pal.chair = '#d4d4dc';
    pal.head = '#e3e3ea';
    pal.wire = mix(floor, ink, 0.36);
    pal.shadow = mix('#6a6c80', ink, 0.3);
    pal.idle.set(mix(floor, ink, 0.28));
    pal.pulse.set(accent);
    pal.globeA.set(accent);
    pal.globeB.set(mix(accent, ink, 0.55));
    pal.halo.set(accent);
    pal.beam.set(accent);
    pal.star.set(accent);
    pal.lamp.set('#ffffff');
    pal.disc = '#ffffff';
  }
  pal.working.set(accent);
  pal.waiting.set(amber);
  pal.failed.set(red);
  pal.done.set(ok);
  pal.lead.set(amber);
  const s = pal.screen;
  if (dark) {
    s.idleBg = mix(floor, ink, 0.07);
    s.idleBar = mix(floor, ink, 0.12);
    s.idleTitle = ink;
    s.idleDim = pal.dim;
    s.idleLine = mix(floor, ink, 0.2);
    s.needsBg = mix(floor, amber, 0.16);
    s.needsHi = amber;
    s.needsLo = mix(floor, amber, 0.4);
    s.needsTitle = amber;
    s.needsText = ink;
    s.needsDim = pal.dim;
    s.workBg = mix(floor, accent, 0.09);
    s.workDisc = mix(floor, ink, 0.07);
    s.workTitle = ink;
    s.workDim = pal.dim;
    s.workTrack = mix(floor, accent, 0.25);
  } else {
    s.idleBg = '#ffffff';
    s.idleBar = '#f1f1f5';
    s.idleTitle = ink;
    s.idleDim = pal.dim;
    s.idleLine = '#e6e6ec';
    s.needsBg = mix('#ffffff', amber, 0.1);
    s.needsHi = amber;
    s.needsLo = mix('#ffffff', amber, 0.35);
    s.needsTitle = mix(amber, ink, 0.2);
    s.needsText = ink;
    s.needsDim = pal.dim;
    s.workBg = mix('#ffffff', accent, 0.05);
    s.workDisc = '#ffffff';
    s.workTitle = ink;
    s.workDim = pal.dim;
    s.workTrack = mix('#ffffff', accent, 0.16);
  }
}

/**
 * A brand or tool colour as it is drawn on the map: light neons are deepened on white, the black-and-white brands take the page's
 * text colour. Always #rrggbb. (The brand's own colour stays the data; this is only how legibly it sits on the map.)
 */
export function brandTone(color: string | null | undefined): string {
  const c = color && color !== '' ? color : '';
  if (!c) return pal.accent;
  if (c === INK) return pal.ink;
  const seen = toneCache.get(c);
  if (seen) return seen;
  const l = luma(c);
  // on white a pale colour fades out: mix it toward the text colour by how pale it is; on black a very dark one does
  const t = pal.dark ? Math.max(0, (0.34 - l) * 1.7) : Math.min(0.6, Math.max(0, (l - 0.6) * 1.5));
  const out = t > 0 ? mix(hex(parse(c)), pal.ink, t) : hex(parse(c));
  toneCache.set(c, out);
  return out;
}

/** A brand colour for a wire nobody is looking at: its tone with most of its colour taken out, toward the grey of the map's lines. */
export function mutedTone(color: string | null | undefined): string {
  const key = color || '';
  let out = mutedCache.get(key);
  if (!out) mutedCache.set(key, (out = mix(brandTone(color), pal.wire, 0.6)));
  return out;
}

/** Calls fn when the map's colours changed: the system's light or dark, or the accent (checked once the page has painted, so a burst of changes is one call). Returns how to stop. */
export function watchPalette(fn: () => void): () => void {
  let frame = 0;
  const check = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (key() !== shown) fn();
    });
  };
  const offTheme = onThemeChange(check);
  // the accent (look.ts) and the UI scale are written onto <html style>: only a different colour counts
  const style = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
  style?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => {
    offTheme();
    style?.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}

