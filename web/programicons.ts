// The mark each program draws in Settings › Programs: its own brand logo where we have one
// (web/icons.ts, via appLogo so its colour reads on the page), else a line icon (web/phosphor.ts).
import { icon } from './icons.ts';
import { appLogo } from './views/stationdata.ts';

/** Program id → the name its logo is filed under, when the id on its own would find the wrong one. */
const BRAND: Record<string, string> = {
  claude: 'claude code', // the program is Claude Code, not the Claude model it runs on
};

/** Program id → a line icon, for the programs Simple Icons has no logo for. */
const LINE: Record<string, string> = {
  // AI tools
  omp: 'terminal',
  hermes: 'sparkles',
  openclaw: 'bot',
  orca: 'rocket',
  netdesk: 'radio',
  opendesign: 'ruler',
  // 3D and animation
  painter: 'paint-brush',
  designer: 'flask',
  sampler: 'camera',
  stager: 'cube-transparent',
  modeler: 'shapes',
  animate: 'film',
  characteranimator: 'mask-happy',
  mesh2motion: 'bone',
  // Creative
  illustrator: 'pen-nib',
  indesign: 'newspaper',
  lightroomclassic: 'aperture',
  lightroom: 'sun-dim',
  bridge: 'folder-open',
  fresco: 'paint-brush',
  acrobat: 'file-pdf',
  dreamweaver: 'code',
  incopy: 'notepad',
  paintnet: 'paint-bucket',
  darktable: 'sliders',
  rawtherapee: 'aperture',
  luminar: 'sun-horizon',
  gigapixel: 'zoom-in',
  affinity: 'triangle',
  irfanview: 'image',
  xnview: 'image-square',
  imagemagick: 'magic-wand',
  opentoonz: 'film-slate',
  pencil2d: 'pencil',
  synfig: 'spiral',
  materialmaker: 'network',
  armorpaint: 'paint-brush',
  magicavoxel: 'cube-transparent',
  meshroom: 'camera-rotate',
  // Audio
  audition: 'waveform',
  reaper: 'sliders',
  musescore: 'music-notes',
  lmms: 'faders',
  // Video
  topazvideo: 'video',
  natron: 'layers',
  mediaencoder: 'export',
  bmdfusion: 'atom',
  capcut: 'scissors',
  shotcut: 'film',
  openshot: 'film',
  mediacomposer: 'film-slate',
  clipchamp: 'browser',
  handbrake: 'swap',
  handbrakecli: 'swap',
  // CAD
  solidworks: 'cube-transparent',
  plasticity: 'polygon',
  shapr3d: 'device-mobile',
  librecad: 'compass-tool',
  // 3D printing
  prusaslicer: 'printer',
  orcaslicer: 'printer',
  cura: 'printer',
  lychee: 'printer',
  chitubox: 'printer',
  simplify3d: 'printer',
  meshmixer: 'shapes',
  // Browsers
  edge: 'browser',
};

/** A program's icon: its brand logo (by id, then by name), else its line icon, else a box. */
export const programIcon = (id: string, name: string, size = 20): SVGSVGElement | HTMLImageElement | null =>
  BRAND[id]
    ? appLogo(BRAND[id], size)
    : LINE[id]
      ? icon(LINE[id], size)
      : appLogo(id, size) ?? appLogo(name, size) ?? icon('box', size);
