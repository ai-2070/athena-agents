// The scene look (docs/internal/plans/HTML_SCENE_PLAN.md): a project's scene is an HTML page in
// <project>/.dashboard/scene/ that draws the Station its own way. It runs in a sandboxed iframe and talks to the
// Station over postMessage. This file is the protocol (both ways), the limits of a scene folder and the file types
// the scene route serves. The page checks every message a scene sends with these schemas: a scene is agent-written
// code, so nothing it says is trusted.
import { z } from 'zod';

/** The protocol's version: in every message, as `athena`. */
export const SCENE_PROTOCOL = 1;

/** How big a scene may be (a folder over these isn't kept as a version, and isn't shown). */
export const SCENE_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  files: 400,
  /** folders inside folders */
  depth: 8,
} as const;

/** The file types a scene may hold, and what they are served as. Anything else is left out of a version. */
export const SCENE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** The type a scene file is served as, or null when a scene may not hold it. */
export function sceneType(file: string): string | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0 || dot < file.lastIndexOf('/')) return null;
  return SCENE_TYPES[file.slice(dot).toLowerCase()] ?? null;
}

/** A path inside a scene folder, as versions keep it ('index.html', 'js/fish.js'): forward slashes, no '.' or '..'
 *  parts, no hidden files. null when it isn't one. */
export function scenePath(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/');
  if (!parts.length || parts.length > SCENE_LIMITS.depth + 1) return null;
  for (const part of parts)
    if (!part || part === '.' || part === '..' || part.startsWith('.') || /[\0-\x1f:*?"<>|]/.test(part)) return null;
  return parts.join('/');
}

// ---------- Athena → scene ----------
export type SceneQuality = 'low' | 'medium' | 'high';
export type SceneStatus = 'idle' | 'working' | 'needs';
export interface SceneTheme {
  theme: 'light' | 'dark';
  /** the accent the user picked (#rrggbb) */
  accent: string;
  reducedMotion: boolean;
  quality: SceneQuality;
}
export interface SceneTeam {
  id: string;
  name: string;
  /** #rrggbb */
  color: string;
  emoji?: string;
  /** agent ids, in order */
  members: string[];
  lead?: string;
  working: string[];
  queued: string[];
}
export interface SceneAgent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  /** 'claude', 'codex'…: for a mark, never for logic */
  engine: string;
  status: SceneStatus;
  /** what the map says it is doing ("Reading files…"), at most 120 characters */
  now: string;
  /** the teams it is in */
  teams: string[];
}
/** What the Station shows, for the scene to draw. Only what the map shows anyway: no chat text, no files. */
export interface SceneState {
  project: { id: string; name: string };
  brain: { name: string; status: 'idle' | 'thinking' | 'needs' };
  teams: SceneTeam[];
  agents: SceneAgent[];
  /** the Needs you count */
  needsYou: number;
}
/** Something that happened, for the scene to animate. */
export type SceneEvent =
  | { kind: 'run-start'; agentId: string; at: number }
  | { kind: 'run-end'; agentId: string; ok: boolean; at: number }
  | { kind: 'tool'; agentId: string; label: string; at: number }
  | { kind: 'handoff'; teamId: string; from: string; to: string; at: number }
  | { kind: 'message'; teamId: string; from: string; at: number }
  | { kind: 'needs'; agentId: string; at: number }
  | { kind: 'brain'; status: 'idle' | 'thinking' | 'needs'; at: number };
export type ScenePickKind = 'agent' | 'team' | 'brain';
export type ToScene = { athena: typeof SCENE_PROTOCOL } & (
  | ({ type: 'hello'; protocol: number } & SceneTheme)
  | { type: 'state'; state: SceneState }
  | { type: 'event'; event: SceneEvent }
  | ({ type: 'theme' } & SceneTheme)
  | { type: 'select'; pick: { kind: ScenePickKind; id?: string } | null }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'look'; request: string; width: number; height: number }
);

// ---------- scene → Athena (untrusted: checked with these schemas) ----------
const id = z.string().min(1).max(200);
const pickKind = z.enum(['agent', 'team', 'brain']);
const at = z.number().finite();
const MAX_IMAGE = 6 * 1024 * 1024;
export const fromSceneSchema = z.discriminatedUnion('type', [
  z.object({ athena: z.literal(SCENE_PROTOCOL), type: z.literal('ready') }),
  z.object({ athena: z.literal(SCENE_PROTOCOL), type: z.literal('pick'), kind: pickKind, id: id.optional() }),
  z.object({
    athena: z.literal(SCENE_PROTOCOL),
    type: z.literal('menu'),
    kind: pickKind,
    id: id.optional(),
    x: at,
    y: at,
  }),
  z.object({
    athena: z.literal(SCENE_PROTOCOL),
    type: z.literal('hover'),
    pick: z.object({ kind: pickKind, id: id.optional() }).nullable(),
  }),
  z.object({
    athena: z.literal(SCENE_PROTOCOL),
    type: z.literal('capture'),
    request: id,
    image: z
      .string()
      .max(MAX_IMAGE)
      .regex(/^data:image\/(png|jpeg|webp);base64,/),
  }),
  z.object({
    athena: z.literal(SCENE_PROTOCOL),
    type: z.literal('log'),
    level: z.enum(['error', 'warn', 'info']),
    text: z.string().transform((t) => t.slice(0, 2000)),
    /** an uncaught error (the helper sets it): before `ready`, it means the scene doesn't load */
    uncaught: z.boolean().optional(),
  }),
  z.object({ athena: z.literal(SCENE_PROTOCOL), type: z.literal('fps'), fps: z.number().finite().min(0).max(1000) }),
]);
export type FromScene = z.infer<typeof fromSceneSchema>;

/** A message from a scene, checked; null when it isn't one (anything else a page may post is ignored). */
export function readSceneMessage(data: unknown): FromScene | null {
  if (!data || typeof data !== 'object' || (data as { athena?: unknown }).athena !== SCENE_PROTOCOL) return null;
  const r = fromSceneSchema.safeParse(data);
  return r.success ? r.data : null;
}
