// The scene tools (docs/internal/plans/HTML_SCENE_PLAN.md §6). Agents write the scene's files with their own file
// tools (Claude Code's Edit and Write, Codex's patches, the built-in write_file and edit_file): these do only what
// file tools can't. scene_check (did the change load?), scene_look (a picture), scene_logs (what the scene said),
// scene_versions and scene_restore (every change is kept), and scene_use (turn the scene look on).
//
// The scene ones don't ask first, and nor do file writes inside the scene folder: a builder changes a scene many times
// in a row, the scene runs sandboxed, and every change is kept so a broken one is one call away from undone. That
// covers scene_restore too: what it replaces or removes stays in the versions. (A deliberate exception to "anything
// that deletes or runs code is high" in AGENTS.md: HTML_SCENE_PLAN.md, Decisions.) scene_use is low: it changes a
// setting for every project, not the scene.
import path from 'node:path';
import { activeProject, getSettings, log, saveSettings } from '../store.ts';
import { isInside } from '../util.ts';
import { BRAIN_ID } from '../brainmcp.ts';
import { isSceneTemplate, SCENE_LIMITS, SCENE_TEMPLATES } from '../../shared/scene.ts';
import {
  restoreVersion,
  sceneDir,
  sceneOverview,
  sceneVersion,
  sceneVersions,
  scanScene,
  setSceneAuthor,
  settleScene,
  startFromTemplate,
  versionFile,
} from './history.ts';
import { requestSceneLook, sceneLogLines, scenePagesOpen, sceneShownLately, waitForLoad } from './look.ts';
import type { JSONSchema, ToolAgent, ToolContext, ToolDef, ToolResult } from '../tools.ts';
import type { ActiveRun, Project, SceneAuthor, SceneVersion } from '../../shared/types.ts';

const str = (description: string): JSONSchema => ({ type: 'string', description });
// (names only: the builders' instructions say what each one is)
const TEMPLATE_LIST = SCENE_TEMPLATES.map((t) => `"${t.id}" (${t.label.toLowerCase()})`).join(', ');
const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

// ---------- who changed the folder ----------
/** The last write into a project's scene folder by a built-in file tool (known exactly). */
const writers = new Map<string, { by: SceneAuthor; at: number }>();

/** May this agent build scenes (it has the scene tools). */
export const buildsScenes = (agent: Pick<ToolAgent, 'id' | 'toolGroups'>): boolean =>
  agent.id === BRAIN_ID || (agent.toolGroups || []).includes('scene');

/** The scene folder of the project the work runs in, for an agent that builds scenes (allowedRoots). */
export const sceneRoots = (agent: Pick<ToolAgent, 'id' | 'toolGroups'>): string[] =>
  agent.id !== BRAIN_ID && buildsScenes(agent) ? [sceneDir(activeProject())] : [];

/** Is this full path inside the scene folder of the project the work runs in? (A relative one can't be told
 *  without the agent's workspace: it counts as outside, so it is asked about like any other write.) */
export function inSceneFolder(p: string): boolean {
  if (!p || !path.isAbsolute(p)) return false;
  return isInside(sceneDir(activeProject()), p);
}

/** A built-in file tool wrote into the scene folder: the version it leads to is this agent's. */
export function noteSceneWrite(abs: string, agent: Pick<ToolAgent, 'id' | 'name'>, runId?: string | null): void {
  if (!inSceneFolder(abs)) return;
  writers.set(activeProject().id, { by: authorOf(agent, runId), at: Date.now() });
}

const authorOf = (agent: Pick<ToolAgent, 'id' | 'name'>, runId?: string | null): SceneAuthor => ({
  kind: agent.id === BRAIN_ID ? 'brain' : 'agent',
  id: agent.id,
  name: agent.name,
  ...(runId ? { runId } : {}),
});

/** Who a change seen in the folder is from: the built-in tool that just wrote there, else the one run going on in
 *  the project (an agent's own file tools), else nobody known. server/engines/index.ts hands it the runs. */
export function sceneAuthor(p: Project, runs: ActiveRun[]): SceneAuthor {
  const w = writers.get(p.id);
  if (w && Date.now() - w.at < 15_000) return w.by;
  const here = runs.filter((r) => (r.projectId || p.id) === p.id);
  if (here.length === 1) return { kind: 'agent', id: here[0].agentId, name: here[0].agentName, runId: here[0].id };
  return { kind: 'outside' };
}
/** Forgets who wrote last (tests). */
export function forgetSceneWriters(): void {
  writers.clear();
}
export function takeSceneRunsFrom(runs: () => ActiveRun[]): void {
  setSceneAuthor((p) => sceneAuthor(p, runs()));
}

// ---------- words ----------
const ago = (at: number): string => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(at).toLocaleString('en-US');
};
const who = (v: SceneVersion): string =>
  v.by.kind === 'user'
    ? 'the user'
    : v.by.kind === 'backup'
      ? 'a backup'
      : v.by.name || (v.by.kind === 'brain' ? 'the Brain' : 'changed in the folder');
const loadsText = (v: SceneVersion): string =>
  v.loads === 'ok'
    ? 'loads'
    : v.loads === 'broken'
      ? `doesn't load${v.error ? `: ${v.error.split('\n')[0].slice(0, 200)}` : ''}`
      : 'not loaded yet';
const size = (v: SceneVersion): string => {
  const n = Object.values(v.files).reduce((a, f) => a + f.size, 0);
  return `${Object.keys(v.files).length} file${Object.keys(v.files).length === 1 ? '' : 's'}, ${Math.max(1, Math.round(n / 1024))} KB`;
};
function changes(v: SceneVersion, before: SceneVersion | undefined): string {
  if (!before) return 'first version';
  const added = Object.keys(v.files).filter((f) => !before.files[f]);
  const removed = Object.keys(before.files).filter((f) => !v.files[f]);
  const changed = Object.keys(v.files).filter((f) => before.files[f] && before.files[f].hash !== v.files[f].hash);
  const part = (label: string, l: string[]) =>
    l.length ? `${label} ${l.slice(0, 4).join(', ')}${l.length > 4 ? ` +${l.length - 4}` : ''}` : '';
  return (
    [part('changed', changed), part('added', added), part('removed', removed)].filter(Boolean).join('; ') || 'no change'
  );
}

/** Why the picture is of the version it is (scene_look): the newest may still be loading, not broken. */
export function shownNote(shown: string, newest: SceneVersion | undefined): string {
  if (!newest || shown === newest.id) return newest ? ' (the newest)' : '';
  if (newest.loads === 'broken') return ` (not the newest, ${newest.id}: that one doesn't load)`;
  if (!newest.loads) return ` (not the newest, ${newest.id}: that one hasn't loaded yet; scene_check waits for it)`;
  return ` (not the newest, ${newest.id})`;
}

const lookOn = (): boolean => getSettings().look.stationLook === 'scene';
const LOOK_OFF =
  "The Station isn't in the scene look, so no page loads the scene. Ask the user to turn it on (Settings › Appearance › Station look › Scene), or call scene_use if they asked to see the scene.";

/** What happened to the newest version, in words (scene_check). */
async function checkText(p: Project): Promise<ToolResult> {
  settleScene(p);
  const folder = scanScene(p);
  const o = sceneOverview(p);
  const lines: string[] = [];
  if (!folder.present) {
    lines.push(
      `There is no scene folder yet: ${sceneDir(p)}. Start one with scene_restore version "starter" (a working pattern to change), or write index.html there.`,
    );
    return { text: lines.join('\n') };
  }
  if (o.problem) lines.push(`The folder's latest state isn't kept or shown: ${o.problem}`);
  if (folder.skipped.length)
    lines.push(`Left out (not served to the scene): ${folder.skipped.slice(0, 10).join(', ')}.`);
  const v = o.versions[0];
  if (!v) {
    lines.push('No version of the scene is kept yet.');
    return { text: lines.join('\n'), isError: true };
  }
  lines.push(`Newest version ${v.id} (${size(v)}), kept ${ago(v.at)}: ${changes(v, o.versions[1])}.`);
  let loaded = v;
  if (!v.loads) {
    if (!lookOn()) {
      lines.push(LOOK_OFF);
      return { text: lines.join('\n') };
    }
    const answered = await waitForLoad(p.id, v);
    loaded = sceneVersion(p, v.id) || v;
    if (!answered && !loaded.loads) {
      lines.push(
        scenePagesOpen()
          ? 'No open Station page loaded it in time (the user may be on another page, or the Station shows another project). Check again later; scene_logs shows what the scene said so far.'
          : 'No dashboard page is open, so nothing loads the scene now. It will be checked when the user opens the Station.',
      );
      return { text: lines.join('\n') };
    }
  }
  if (loaded.loads === 'ok') lines.push('It loads: the Station shows it.');
  else {
    const good = o.newestGood ? sceneVersion(p, o.newestGood) : null;
    lines.push(
      `It doesn't load: ${loaded.error || 'no reason given'}`,
      good
        ? `The Station shows the version of ${new Date(good.at).toLocaleString('en-US')} (${good.id}) instead. Fix the files, or go back with scene_restore.`
        : 'No version has loaded yet, so the Station shows the starter scene. Fix the files and check again.',
    );
  }
  const errors = sceneLogLines(p.id).filter((l) => l.version === loaded.id && l.level !== 'info');
  if (errors.length)
    lines.push(
      'What the scene logged:',
      ...errors.slice(-8).map((l) => `- ${l.level}: ${l.text.split('\n').slice(0, 3).join(' | ')}`),
    );
  return { text: lines.join('\n'), isError: loaded.loads === 'broken' };
}

export function sceneTools(): ToolDef[] {
  return [
    {
      name: 'scene_check',
      group: 'scene',
      risk: 'none',
      description:
        "After changing the scene's files: keeps the change as a version, waits for the open Station to load it, and says whether it loads (or why not, with the scene's errors). Call it after every change and fix what it reports before going on.",
      parameters: obj({}),
      run: async () => checkText(activeProject()),
    },
    {
      name: 'scene_look',
      group: 'scene',
      risk: 'none',
      description:
        'A picture of the scene as the open Station shows it now, to see what you built. Needs the scene look on and a Station page open.',
      parameters: obj({
        width: { type: 'number', description: 'Picture width in pixels (default 1280, at most 1920)' },
        height: { type: 'number', description: 'Picture height in pixels (default 800, at most 1200)' },
      }),
      run: async ({ width, height }: { width?: number; height?: number }) => {
        const p = activeProject();
        if (!lookOn()) return { text: LOOK_OFF, isError: true };
        const clamp = (n: unknown, d: number, max: number) =>
          Math.max(200, Math.min(max, Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : d));
        const r = await requestSceneLook(p.id, { width: clamp(width, 1280, 1920), height: clamp(height, 800, 1200) });
        if (!r.image) return { text: r.note || 'No picture came back.', isError: true };
        const shown = r.version ? ` It shows version ${r.version}${shownNote(r.version, sceneVersions(p)[0])}.` : '';
        return { text: `The scene as the Station shows it.${shown}`, images: [r.image] };
      },
    },
    {
      name: 'scene_logs',
      group: 'scene',
      risk: 'none',
      description:
        'What the scene logged in the open Station (errors, console.error and console.warn, Athena.log), newest last, with the version each line came from.',
      parameters: obj({ all: { type: 'boolean', description: 'Every version (default: the newest version only)' } }),
      run: async ({ all }: { all?: boolean }) => {
        const p = activeProject();
        const newest = sceneVersions(p)[0]?.id;
        const lines = sceneLogLines(p.id).filter((l) => all || l.version === newest);
        const head = sceneShownLately(p.id)
          ? 'An open Station shows this scene.'
          : lookOn()
            ? 'No open Station has shown this scene in the last half minute.'
            : LOOK_OFF;
        if (!lines.length) return { text: `${head}\nNothing logged${all ? '' : ' for the newest version'}.` };
        return {
          text: [head, ...lines.slice(-50).map((l) => `[${l.version} ${ago(l.at)}] ${l.level}: ${l.text}`)].join('\n'),
        };
      },
    },
    {
      name: 'scene_versions',
      group: 'scene',
      risk: 'none',
      description:
        "The scene's kept versions, newest first: when, who, what changed, whether it loads. With version: its files. With version and path: that file's text as it was then (to compare with now and see what broke).",
      parameters: obj({ version: str('A version id'), path: str('A file in that version, e.g. index.html') }),
      run: async ({ version, path: file }: { version?: string; path?: string }) => {
        const p = activeProject();
        const list = sceneVersions(p);
        if (!version) {
          if (!list.length) return { text: 'No version of the scene is kept yet.' };
          return {
            text: list
              .slice(0, 30)
              .map(
                (v, i) =>
                  `${v.id} · ${ago(v.at)} · ${who(v)} · ${loadsText(v)}${v.pinned ? ' · kept' : ''} · ${v.note ? `${v.note}; ` : ''}${changes(v, list[i + 1])}`,
              )
              .join('\n'),
          };
        }
        const v = sceneVersion(p, version);
        if (!v) return { text: `There is no version ${version}. scene_versions lists them.`, isError: true };
        if (!file)
          return {
            text: `${v.id} (${size(v)}, ${loadsText(v)}):\n${Object.entries(v.files)
              .map(([f, x]) => `- ${f} (${x.size} bytes)`)
              .join('\n')}`,
          };
        const buf = versionFile(p, v, file);
        if (!buf) return { text: `Version ${v.id} has no file ${file}.`, isError: true };
        const text = buf.toString('utf8');
        return { text: text.length > 100_000 ? `${text.slice(0, 100_000)}\n… (cut at 100,000 characters)` : text };
      },
    },
    {
      name: 'scene_restore',
      group: 'scene',
      risk: 'none',
      description: `Writes an earlier version of the scene (or one file of it, with path) back into the folder; that becomes the newest version, and later ones stay kept. Or replaces the scene with a template: ${TEMPLATE_LIST}.`,
      parameters: obj(
        {
          version: str('A version id from scene_versions, or a template name'),
          path: str('Only this file'),
        },
        ['version'],
      ),
      run: async ({ version, path: file }: { version: string; path?: string }, ctx: ToolContext) => {
        const p = activeProject();
        const by = authorOf(ctx.agent, ctx.runId);
        try {
          if (isSceneTemplate(version)) {
            const v = startFromTemplate(p, version, by);
            log('project', `${ctx.agent.name} started the scene from the ${version} template in "${p.name}"`);
            return {
              text: `${v ? `Copied the ${version} scene in (version ${v.id})` : `The folder already had the ${version} scene`}: ${sceneDir(p)}. Change it from there, then scene_check.`,
            };
          }
          const v = restoreVersion(p, version, by, file || undefined);
          log('project', `${ctx.agent.name} went back to an earlier version of the scene in "${p.name}"`);
          return {
            text: v
              ? `${v.note}. That is now the newest version (${v.id}); scene_check says whether it loads.`
              : 'The folder already was that version.',
          };
        } catch (e) {
          return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
      },
    },
    {
      name: 'scene_use',
      group: 'scene',
      risk: 'low',
      description:
        'Turns the Station\'s scene look on (look "scene") or back to the classic map ("classic"). A setting for every project: only when the user asks to see the scene, or to leave it.',
      parameters: obj({ look: { type: 'string', enum: ['scene', 'classic'], description: '"scene" or "classic"' } }, [
        'look',
      ]),
      run: async ({ look }: { look: string }, ctx: ToolContext) => {
        if (look !== 'scene' && look !== 'classic') return { text: 'look is "scene" or "classic".', isError: true };
        saveSettings({ look: { stationLook: look } });
        log(
          'settings',
          `${ctx.agent.name} turned the Station's ${look === 'scene' ? 'scene look on' : 'classic look on'}`,
        );
        return {
          text: look === 'scene' ? 'The Station now shows the scene.' : 'The Station is back to the classic map.',
        };
      },
    },
  ];
}

/** What builders are told about the scene (added to their instructions when they have the scene tools). */
export function scenePrompt(toolNames: string[], engine?: string): string {
  if (!toolNames.includes('scene_check')) return '';
  const p = activeProject();
  const dir = sceneDir(p);
  const o = sceneOverview(p);
  const state = !o.present
    ? 'It has no scene yet: start from a template (scene_restore version "starter", or a finished sample to change: "garden", "solar") unless asked for something else.'
    : o.versions[0]?.loads === 'broken'
      ? `Its newest version doesn't load (${o.versions[0].error || 'see scene_check'}); the Station shows an older one.`
      : 'It has a scene: read it before changing it.';
  const reach =
    engine && !['claude-code', 'codex', 'eve'].includes(engine)
      ? '\nIf your file tools are not allowed to write there, say so to the user instead of trying another way.'
      : '';
  return `
# The Station's scene
The Station can show a scene: a web page that draws this project's Brain, teams and agents its own way (three.js, a 2D canvas, anything a browser shows). This project's scene is the folder ${dir} (entry: index.html). ${state}
Change it with your file tools, using full paths in that folder. After each change call scene_check and fix what it reports before going on; look at it with scene_look. Every change is kept: scene_versions and scene_restore bring back an earlier one, so a broken scene is never a disaster, and the Station keeps showing the last version that loads.${reach}
How a scene works:
- It runs sandboxed: no network, no fetch outside its own folder, no localStorage (Athena.store instead), no popups. Files: at most ${SCENE_LIMITS.files}, ${SCENE_LIMITS.fileBytes / 1048576} MB each, ${SCENE_LIMITS.totalBytes / 1048576} MB in all.
- three.js comes from the Station: an import map with "three": "/scene-lib/three/three.module.js" and "three/addons/": "/scene-lib/three/addons/" (the starter's index.html has it).
- import { Athena } from '/scene-lib/athena-scene.js'. Athena.onState(s => …) gives { project, brain: { status }, teams: [{ id, name, color, emoji, members, lead, working, queued }], agents: [{ id, name, emoji, color, engine, status: idle|working|needs, now, teams }], needsYou }: draw everything from it and keep things by id. Athena.onEvent(e => …) for animation (run-start, run-end, tool, handoff, message, needs, brain). Athena.onTheme(t => …): theme light|dark, accent, reducedMotion, quality. Athena.onPause(paused => …): stop drawing while paused.
- On click: Athena.pick('agent'|'team'|'brain', id) opens the Station's panel; right-click: Athena.menu(kind, id, x, y); hover: Athena.hover(kind, id) or Athena.hover(null).
- Labels: call Athena.anchors([{ kind, id, x, y }, …]) each frame with where things are on screen (in the scene's pixels, for what is visible) and the Station draws its own labels there (names, status, what an agent is doing), clickable. Then draw no labels of your own. The garden and solar templates do this.
- Athena.setCapture(() => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); }) so scene_look gets a picture. (It is the canvas only: HTML drawn over it, like the starter's labels, isn't in the picture.)
- Call Athena.ready() once set up. A scene that throws before that (or in the 5 seconds after), never calls it, or freezes the page counts as not loading.
- It should read well in light and dark, with one agent or fifty, and with no teams.
`;
}
