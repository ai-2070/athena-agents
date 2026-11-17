// The Athena scene helper: a scene imports it to talk to the Station (docs/internal/plans/HTML_SCENE_PLAN.md §5, §7).
//
//   import { Athena } from '/scene-lib/athena-scene.js';
//   Athena.onState((state) => { ... draw the teams and agents ... });
//   Athena.onEvent((event) => { ... animate a handoff ... });
//   Athena.onTheme((theme) => { ... light or dark ... });
//   Athena.setCapture(() => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); });
//   canvas.addEventListener('click', () => Athena.pick('agent', id));
//   Athena.ready(); // once the scene is set up: until then (and for 5 seconds after), an uncaught error means the
//                   // scene doesn't load, and the Station shows the last version that did
//
// The scene runs sandboxed: no network, no localStorage (Athena.store, in memory, stands in for it), no popups.
// It sends errors and console.error/warn to the Station (builders read them with scene_logs), and its frame rate.

const PROTOCOL = 1;
const parentWindow = window.parent;

const post = (msg) => {
  try {
    parentWindow.postMessage({ athena: PROTOCOL, ...msg }, '*');
  } catch {
    /* the Station went away */
  }
};

const listeners = { state: [], event: [], theme: [], pause: [], select: [] };
const call = (kind, value) => {
  for (const fn of listeners[kind]) {
    try {
      fn(value);
    } catch (e) {
      report('error', e, true);
    }
  }
};

function describe(e) {
  if (e instanceof Error)
    return `${e.name}: ${e.message}${e.stack ? `\n${String(e.stack).split('\n').slice(1, 4).join('\n')}` : ''}`;
  try {
    return typeof e === 'string' ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}
function report(level, e, uncaught = false) {
  post({ type: 'log', level, text: describe(e).slice(0, 2000), uncaught });
}

// ---------- what the Station says ----------
let capture = null;
window.addEventListener('message', (ev) => {
  if (ev.source !== parentWindow) return;
  const m = ev.data;
  if (!m || typeof m !== 'object' || m.athena !== PROTOCOL) return;
  switch (m.type) {
    case 'hello':
    case 'theme': {
      Athena.theme = { theme: m.theme, accent: m.accent, reducedMotion: !!m.reducedMotion, quality: m.quality };
      call('theme', Athena.theme);
      break;
    }
    case 'state':
      Athena.state = m.state;
      call('state', m.state);
      break;
    case 'event':
      call('event', m.event);
      break;
    case 'select':
      Athena.selected = m.pick;
      call('select', m.pick);
      break;
    case 'pause':
    case 'resume':
      Athena.paused = m.type === 'pause';
      call('pause', Athena.paused);
      break;
    case 'look':
      void answerLook(m);
      break;
  }
});

async function answerLook(m) {
  let image = null;
  try {
    image = capture ? await capture({ width: m.width, height: m.height }) : biggestCanvas()?.toDataURL('image/png');
  } catch (e) {
    report('warn', e);
  }
  if (typeof image === 'string' && image.startsWith('data:image/'))
    post({ type: 'capture', request: m.request, image });
  else report('warn', 'A picture was asked for, but the scene could not make one (use Athena.setCapture).');
}

function biggestCanvas() {
  let best = null;
  for (const c of document.querySelectorAll('canvas'))
    if (!best || c.width * c.height > best.width * best.height) best = c;
  return best;
}

// ---------- errors and the console ----------
window.addEventListener('error', (e) => report('error', e.error || e.message, true));
window.addEventListener('unhandledrejection', (e) => report('error', e.reason, true));
for (const level of ['error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    report(level, args.map(describe).join(' '));
  };
}

// ---------- localStorage stand-in (a sandboxed page has none: reading it throws) ----------
const memory = new Map();
const store = {
  get length() {
    return memory.size;
  },
  key: (i) => [...memory.keys()][i] ?? null,
  getItem: (k) => (memory.has(String(k)) ? memory.get(String(k)) : null),
  setItem: (k, v) => void memory.set(String(k), String(v)),
  removeItem: (k) => void memory.delete(String(k)),
  clear: () => memory.clear(),
};
try {
  void window.localStorage;
} catch {
  try {
    Object.defineProperty(window, 'localStorage', { value: store, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: store, configurable: true });
  } catch {
    /* scenes use Athena.store instead */
  }
}

// ---------- frame rate (the Station's freeze check, and a hint to draw less) ----------
let frames = 0;
let since = performance.now();
function count(now) {
  frames++;
  if (now - since >= 2000) {
    if (!Athena.paused && document.visibilityState === 'visible')
      post({ type: 'fps', fps: Math.round((frames * 1000) / (now - since)) });
    frames = 0;
    since = now;
  }
  requestAnimationFrame(count);
}
requestAnimationFrame(count);

export const Athena = {
  /** The Station's last state (null until it arrives). */
  state: null,
  /** Light or dark, the accent, reduced motion and quality (null until they arrive). */
  theme: null,
  /** What the side panel shows ({ kind, id }) or null. */
  selected: null,
  /** The Station is hidden: stop drawing until it comes back (onPause tells). */
  paused: false,
  /** In-memory storage, in place of localStorage. */
  store,
  onState(fn) {
    listeners.state.push(fn);
    if (Athena.state) fn(Athena.state);
  },
  onEvent(fn) {
    listeners.event.push(fn);
  },
  onTheme(fn) {
    listeners.theme.push(fn);
    if (Athena.theme) fn(Athena.theme);
  },
  onPause(fn) {
    listeners.pause.push(fn);
  },
  onSelect(fn) {
    listeners.select.push(fn);
  },
  /** How the scene makes a picture of itself for builders: a function returning a data: URL (PNG or JPEG). */
  setCapture(fn) {
    capture = fn;
  },
  /** The user clicked something: the Station opens its panel. kind: 'agent', 'team' or 'brain'. */
  pick(kind, id) {
    post({ type: 'pick', kind, ...(id ? { id } : {}) });
  },
  /** The user right-clicked something, at x, y in the scene: the Station opens its menu there. */
  menu(kind, id, x, y) {
    post({ type: 'menu', kind, ...(id ? { id } : {}), x, y });
  },
  /** The pointer is over something (or nothing: null). */
  hover(kind, id) {
    post({ type: 'hover', pick: kind ? { kind, ...(id ? { id } : {}) } : null });
  },
  /** Something for builders to read (scene_logs). */
  log(text, level = 'info') {
    report(level, text);
  },
  /** The scene is set up: the Station sends the theme and the state. */
  ready() {
    post({ type: 'ready' });
  },
};
