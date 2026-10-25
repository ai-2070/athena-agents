// Settings: everything you set up once, in tabs. General · Connections · MCP servers · Programs.
import { h, mount } from '../core.js';
import * as general from './settings.js';
import * as connections from './connections.js';
import * as mcp from './mcp.js';
import * as programs from './programs.js';

const TABS = [
  { id: 'general', label: 'General & keys', view: general },
  { id: 'connections', label: 'Connections', view: connections },
  { id: 'mcp', label: 'MCP servers', view: mcp },
  { id: 'programs', label: 'Programs', view: programs },
];

let tab = 'general';
let inner = null;

export const title = () => 'Settings';

export async function render(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (TABS.some((t) => t.id === q.get('tab'))) tab = q.get('tab');
  const body = h('div');
  const draw = async () => {
    inner?.unmount?.();
    inner = TABS.find((t) => t.id === tab).view;
    mount(el, h('div.tabs', TABS.map((t) => h(`button${tab === t.id ? '.on' : ''}`, { onclick: () => ((tab = t.id), history.replaceState(null, '', `#/settings?tab=${t.id}`), draw()) }, t.label))), body);
    await inner.render(body, []);
  };
  await draw();
}

export function unmount() {
  inner?.unmount?.();
}

export function onEvent(ev) {
  inner?.onEvent?.(ev);
}
