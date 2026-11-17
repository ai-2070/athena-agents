// Serving scenes (docs/internal/plans/HTML_SCENE_PLAN.md §4). A scene is agent-written code, so it never runs in the
// app's origin: the Station shows it in <iframe sandbox="allow-scripts">, and every response here carries a policy
// that sandboxes it again (even opened on its own) and lets it load only its own files and the scene library: no
// API, no other website.
//
//   /scene/<token>/v/<version>/<path>   a file of a kept version (never the live folder)
//   /scene/<token>/starter/<path>       the starter scene, for a project without one that loads
//   /scene-lib/athena-scene.js          the helper scenes talk to the Station through
//   /scene-lib/three/<file>             three.js, the version the app uses; /scene-lib/three/addons/<path> its addons
//
// A sandboxed page has no origin of its own, so its module scripts are cross-origin requests: the files answer with
// `access-control-allow-origin: *`. The token in the path (random, made by `scene.open`, forgotten on restart)
// keeps another website from reading a project's scene that way.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listProjects } from '../store.ts';
import { ROOT } from '../util.ts';
import { sceneType } from '../../shared/scene.ts';
import { sceneVersion, versionFile, watchScene } from './history.ts';

const STARTER = path.join(ROOT, 'scene', 'starter');
const HELPER = path.join(ROOT, 'scene', 'lib', 'athena-scene.js');
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build');
const THREE_ADDONS = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
/** the three.js files a scene may import (three.module.js imports three.core.js) */
const THREE_FILES = new Set(['three.module.js', 'three.core.js', 'three.webgpu.js', 'three.tsl.js']);

const tokens = new Map<string, string>();
const tokenOf = new Map<string, string>();

/** The token a project's scene is served under (the same one until the server restarts). */
export function sceneToken(projectId: string): string {
  let t = tokenOf.get(projectId);
  if (!t) {
    t = crypto.randomBytes(18).toString('base64url');
    tokens.set(t, projectId);
    tokenOf.set(projectId, t);
  }
  watchScene(projectId);
  return t;
}

export interface SceneResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** The policy a scene's files are served with. Only its own files (by its token) and the library; nothing else. */
export function sceneCsp(host: string, token: string): string {
  const own = `http://${host}/scene/${token}/ http://${host}/scene-lib/`;
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${own} 'unsafe-inline' 'wasm-unsafe-eval' blob:`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `media-src ${own} data: blob:`,
    `font-src ${own} data:`,
    // (three.js loads models and textures with fetch)
    `connect-src ${own} data: blob:`,
    `worker-src ${own} blob:`,
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors http://${host}`,
  ].join('; ');
}

const notFound = (): SceneResponse => ({
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
  body: 'Not found',
});

function file(abs: string, root: string, cache: string, extra: Record<string, string>): SceneResponse {
  const real = path.resolve(abs);
  if (!real.startsWith(root + path.sep)) return notFound();
  const type = sceneType(real.replace(/\\/g, '/'));
  let body: Buffer;
  try {
    if (!fs.lstatSync(real).isFile()) return notFound();
    body = fs.readFileSync(real);
  } catch {
    return notFound();
  }
  return { status: 200, headers: { ...base(type || 'application/octet-stream', cache), ...extra }, body };
}

const base = (type: string, cache: string): Record<string, string> => ({
  'content-type': type,
  'cache-control': cache,
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
});

/** The answer to a GET under /scene/ or /scene-lib/, or null for any other path. `host` is the request's Host
 *  (already checked by the server). */
export function sceneResponse(pathname: string, host: string): SceneResponse | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return pathname.startsWith('/scene') ? notFound() : null;
  }
  if (rel.startsWith('/scene-lib/')) {
    const rest = rel.slice('/scene-lib/'.length);
    const csp = { 'content-security-policy': "sandbox; default-src 'none'" };
    if (rest === 'athena-scene.js') return file(HELPER, path.dirname(HELPER), 'no-cache', csp);
    if (rest.startsWith('three/addons/'))
      return file(path.join(THREE_ADDONS, rest.slice('three/addons/'.length)), THREE_ADDONS, 'max-age=86400', csp);
    if (rest.startsWith('three/') && THREE_FILES.has(rest.slice('three/'.length)))
      return file(path.join(THREE_BUILD, rest.slice('three/'.length)), THREE_BUILD, 'max-age=86400', csp);
    return notFound();
  }
  if (!rel.startsWith('/scene/')) return null;
  const m = /^\/scene\/([A-Za-z0-9_-]+)\/(?:v\/([\w-]+)|(starter))\/(.*)$/.exec(rel);
  if (!m) return notFound();
  const [, token, versionId, starter, inner] = m;
  const projectId = tokens.get(token);
  const p = projectId ? listProjects().find((x) => x.id === projectId) : null;
  if (!p) return notFound();
  const path0 = inner || 'index.html';
  const csp = { 'content-security-policy': sceneCsp(host, token) };
  if (starter) return file(path.join(STARTER, ...path0.split('/')), STARTER, 'no-cache', csp);
  const v = sceneVersion(p, versionId);
  if (!v) return notFound();
  const type = sceneType(path0);
  const body = type ? versionFile(p, v, path0) : null;
  if (!type || !body) return notFound();
  // a version never changes
  return { status: 200, headers: { ...base(type, 'private, max-age=31536000, immutable'), ...csp }, body };
}

/** Forgets every token (tests). */
export function forgetSceneTokens(): void {
  tokens.clear();
  tokenOf.clear();
}
