// MCP services use their brand mark where available, then an icon for what they do.
import { icon } from './icons.ts';
import { appLogo } from './views/stationdata.ts';

const BRANDS: Record<string, string> = {
  'chrome-devtools': 'chrome', 'substance-painter': 'painter', 'comfy-cloud': 'comfyui',
};
const LINES: Record<string, string> = {
  playwright: 'browser', filesystem: 'folder', fetch: 'globe', memory: 'network', 'sequential-thinking': 'brain',
  context7: 'library-big', firecrawl: 'globe', deepwiki: 'library-big', 'microsoft-learn': 'library-big',
  'aws-knowledge': 'server', 'twilio-docs': 'library-big', kiwi: 'globe', monday: 'workflow',
  craft: 'notepad', fireflies: 'waveform', gamma: 'layout-grid', composio: 'plug', semgrep: 'shield-check',
  globalping: 'network', amplitude: 'gauge', 'twelve-data': 'gauge', attio: 'users', close: 'users',
  klaviyo: 'mail', himalaya: 'mail', tripo: 'cube-transparent', meshy: 'shapes', '3d-printer': 'printer',
  reaper: 'faders', musescore: 'music-notes', topaz: 'zoom-in',
};

export function presetIcon(name: string, size = 17): SVGSVGElement | HTMLImageElement {
  return appLogo(BRANDS[name] || name, size) || icon(LINES[name] || 'plug', size);
}
