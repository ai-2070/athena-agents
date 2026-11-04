// The agents' voxel world tools (the "world" tool group). Building only touches the dashboard's own world
// and can be undone, so it is low risk; changing or deleting what someone else built asks first (high).
import { log } from '../store.ts';
import { withActor } from '../versions.ts';
import { VERBS, BuildError, LIMITS } from './ops.ts';
import { build, changeObject, findObject, findPrefab, ownsObject, undo } from './build.ts';
import { setEffect, setEnvironment, setLight, EFFECT_KINDS, SCENE_LIMITS, WEATHER } from './scene.ts';
import { ENV_PRESETS } from '../../shared/worldenv.ts';
import { playAnimation, setAnimation, setSkin, skinTarget } from './characters.ts';
import { activeProject, getSettings, saveSettings, workflows } from '../store.ts';
import { requestApproval } from '../approvals.ts';
import type { ApprovalRequest } from '../approvals.ts';
import { loadSandbox, runScript, SCRIPT_LIMITS } from './script.ts';
import { BUILD_ORDER, DIORAMA, DIORAMA_TINY } from './diorama.ts';
import { requestLook } from './look.ts';
import { exportFiles, importVox, writeFiles, writePicture } from './exchange.ts';
import { objectMap } from './describe.ts';
import { changePrefab, deletePrefab, importPrefab, libraryList, prefabList, publishPrefab, savePrefabFrom } from './prefabs.ts';
import { shownWorld } from './link.ts';
import { worldInfo } from './describe.ts';
import { KEEP_WORLD_MD, readWorldMd, worldMdStamp, writeWorldMd, writeWorldMdSection, worldMdContext } from './worldmd.ts';
import type { JSONSchema, Risk, ToolArgs, ToolContext, ToolDef, ToolResult, ToolRunInfo, ToolAgent } from '../tools.ts';
import type { WorldBuilder, WorldLookView } from '../../shared/types.ts';

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

type Gate = (agent: ToolAgent, name: string, risk: Risk, args: ToolArgs, ctx?: ToolRunInfo, detail?: string | null) => Promise<ToolResult | null>;

const str = (description: string): JSONSchema => ({ type: 'string', description });
const num = (description: string): JSONSchema => ({ type: 'number', description });
const vec = (description: string): JSONSchema => ({ type: 'array', items: { type: 'number' }, description });
const oneOf = (values: readonly string[], description?: string): JSONSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
const ANCHOR = 'world, brain, team:<id> or agent:<id>';
const PIN = 'Pin it to an object (name or id): position is then from it';
const LOOK_TARGETS: WorldLookView['target'][] = ['overview', 'brain', 'team', 'agent', 'object', 'prefab'];
const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const builderOf = (ctx: ToolContext): WorldBuilder => ({ kind: 'agent', id: ctx.agent.id, name: ctx.agent.name });
const failed = (e: unknown): ToolResult => ({ text: e instanceof Error ? e.message : String(e), isError: true });

// WORLD.md reads in a run, so a whole rewrite is only made over the version the agent saw.
const mdRead = new Map<string, number>();
const readKey = (ctx: ToolContext, worldId: string) => `${ctx.runId || ctx.agent.id}:${worldId}`;

/** The whole build language by topic (world_steps); world_build's description has the common part. */
export const STEP_TOPICS: Record<string, string> = {
  units: `Units: with "units": "map" on the call (recommended), every position and size in the steps is in map units, the same numbers world_info, WORLD.md and plans use: {"box": [4, 3, 6]} is 4 map units wide whatever the voxel size. Without it they are whole voxels of the current voxel size (at 0.25, 4 map units is 16 voxels). One step can say "units": "map" on its own. Drawings stay in voxels either way: "layers", heightmap "rows", extrude "rows" and text "scale" (one character = one voxel). Map units: a desk is 2.6 wide, a person 1.7 tall, the floor is y = 0, the cursor starts at the object's origin.`,
  state: `State steps: {"voxel_size": 0.1} (the next steps build at that size; one object can mix sizes), {"use": "stone"}, {"material": "name", "color": "#rrggbb", "ramp": ["#..", "#.."], "jitter": 0.08, "kind": "solid|glass|water|emissive|metal|leaf|snow", "emissive": 3, "opacity": 0.6} (define or change a material, then use it), {"at": [x, y, z]} (move the cursor), {"move": [dx, dy, dz]}, {"mirror": "x"} (or ["x", "z"], "none": mirror the following steps across the cursor), {"seed": 7}.`,
  shapes: `Shapes (each may take "at": offset from the cursor, "use": material, "erase": true, "keep": true to fill only empty voxels, "hollow": true): {"box": [w, h, d]} (from its corner; "frame": true for edges only), {"sphere": r}, {"ellipsoid": [rx, ry, rz]}, {"blob": [rx, ry, rz], "rough": 0.3, "holes": 0.2} (organic: crowns, bushes, clouds, rocks), {"cylinder": r, "height": h, "axis": "y"}, {"cone": r, "height": h, "down": false}, {"pyramid": [w, d], "height": h}, {"torus": R, "tube": r}, {"line": [x, y, z], "thickness": 1} (to that point), {"stairs": {"steps": n, "width": w, "dir": "+x", "rise": 1, "run": 1}} (rise and run: each step's height and depth), {"arch": {"width": w, "height": h, "thickness": 1, "depth": 1, "axis": "x"}}, {"set": [[x, y, z], …]}, {"layers": [["row", …] (bottom layer first; each row runs along x, rows along z)], "key": {"#": "stone", "o": "lantern"}} ("." is empty), {"text": "DINER", "facing": "+z", "scale": 1, "depth": 1}, {"heightmap": {"rows": ["0123", …]} or {"size": [w, d], "height": 6, "cell": 12}, "top": "grass"}, {"replace": {"from": "stone", "to": "moss", "chance": 0.3}, "in": [w, h, d]}, {"clear": true} (everything at this voxel size), {"scatter": {"count": 20, "area": [w, d], "step": {…any step…}}}.
Shape tools: {"revolve": [[radius, height], …], "sides": 0} (a profile turned around the vertical: columns, domes, vases, trunks, minarets; "sides": 4 for square, 8 for octagonal), {"extrude": {"points": [[x, z], …]} or {"rows": ["##..", …]}, "height": h, "wall": 1} (an outline raised: floor plans, walls, plazas, fields; "wall" for hollow walls that thick), {"path": [[x, z] or [x, y, z], …], "width": w, "height": 1} (a brush swept along points: roads, rivers, canals, walls).`,
  regions: `Region tools (a box w×h×d from the spot): {"copy": [w, h, d], "from": [x, y, z], "at": [x, y, z], "turn": 90, "mirror": "x"}, {"shift": [w, h, d], "from": […], "at": […]} (move it), {"rotate": [w, h, d], "at": […], "turn": 90} (in place), {"flip": [w, h, d], "at": […], "axis": "x"}.`,
  finishing: `Finishing (on everything at this voxel size, or "in": [w, h, d] from the spot): {"snow_cover": {"depth": 1, "chance": 0.9}} (snow on every ledge the sky can see), {"overgrow": {"chance": 0.25, "hang": 3}, "use": "moss"} (tufts on top, vines down walls), {"weather": {"amount": 0.3}} (wear and dirt, more near the ground).`,
  prefabs: `Prefabs (small models made once and placed many times; see world_prefab): {"place": "Palm tree", "at": [x, y, z], "turn": 30} places one copy (any angle; "tilt"/"roll" 0/90/180/270, "scale", "mirror": true, "swap": {"shirt": "cloth red"} to recolour a material in that copy). Many at once: "scatter": {"area": [w, d], "count": 60, "spacing": 6}, or "along": [[x, z], …] with "every": 12, "sides": 2, "offset": 4, "face": "along"|"across", or "grid": {"rows": 3, "cols": 5, "gap": [6, 8]}. "place" can be a list of prefabs to pick from, "turn": "random" or [min, max], "scale": [min, max], "mirror": "random", "swap": a list to pick from. Many copies stand on what is built below them ("on": "surface"); a single one stands exactly at "at" unless "on": "surface". "avoid": "solid" skips spots inside something built.
{"unplace": "Palm tree" (or a list, or "all"), "in": [w, h, d]} takes copies away. {"stamp": "Window", "at": [x, y, z], "turn": 90, "swap": {…}} bakes a prefab into this object's voxels (quarter turns), for parts of a building.`,
  characters: `Characters: an agent can take any form (world_skin "character"): a person, an animal, a tree, a lamp. Build each moving part as its own prefab (a "pivot" of "top" for an arm that swings from the shoulder), then build the character prefab by placing the parts one at a time with "name": {"place": "Arm", "at": [0.3, 1.2, 0], "name": "left arm"} (in map units). Parts can hold parts. A prefab without parts moves whole with "self".
Animations: world_animate {"action": "set", "prefab": "Robot", "clip": "working", "duration": 1.2, "loop": true, "tracks": {"left arm": [{"t": 0, "turn": [0, 0, 0]}, {"t": 0.5, "turn": [-40, 0, 0], "ease": "smooth"}, {"t": 1, "turn": [0, 0, 0], "ease": "smooth"}], "self": [{"t": 0, "move": [0, 0, 0]}, {"t": 0.5, "move": [0, 0.05, 0]}, {"t": 1, "move": [0, 0, 0]}]}}. "t" runs from 0 to 1 over the duration; "turn" is degrees [x, y, z] around the part's pivot (x tips forward and back), "move" map units, "scale" a number, "ease" linear, smooth, step or bounce. Clips named "idle", "working" and "needs" play while the agent is idle, working or waiting for the user; play others once with world_animate "play" (a cheer, a bow), or pick them per state with world_skin "states".`,
  materials: `Stock materials (by name, no need to define): grass, moss, dirt, sand, stone, dark stone, cobble, brick, white plaster, wood, dark wood, bark, leaves, pine needles, blossom, autumn leaves, bamboo, water, glass, ice, snow, cloud, red lacquer, roof tile, gold, iron, lantern, neon pink, neon blue, fire, cloth white, skin light, skin medium, skin dark.`,
  script: `Code (world_build "code"): a JavaScript program that builds through the same steps, everything in map units from the cursor. It runs sealed off (no files, no network, no timers) for at most ${SCRIPT_LIMITS.ms / 1000} seconds and ${LIMITS.scriptSteps.toLocaleString('en-US')} steps (set() voxels count once per ${LIMITS.setPoints.toLocaleString('en-US')}).
State: use(material), material(name, {color, ramp, jitter, kind, emissive, opacity}), voxelSize(s), at(x, y, z), move(dx, dy, dz), mirror("x").
Shapes take the position first and their step's own fields last, as opts ({use, erase, hollow, keep} and the shape's own): box(corner, [w, h, d], opts), sphere(p, r, opts), ellipsoid(p, [rx, ry, rz], opts), blob(p, [rx, ry, rz], opts) ({rough, holes}), cylinder(p, r, height, opts) ({axis}), cone(p, r, height, opts), line(a, b, opts) ({thickness}), path([[x, z], …], width, opts) ({height}), extrude([[x, z], …], height, opts) ({wall}), revolve(p, [[radius, height], …], opts) ({sides}), place(prefab, p, opts) ({turn, scale, swap, mirror, name}), stamp(prefab, p, opts). set(x, y, z, material) and erase(x, y, z) change single voxels; step({…}) runs any other step.
Read: solid(x, y, z), materialAt(x, y, z), top(x, z, fromY) (the height built there looking down from fromY, default 64, or null), random() (the same numbers each run unless "seed" changes), noise(x, z, cell) (0 to 1, smooth over cell map units, default 8), log(…) (comes back to you), Math.
Example, a row of six cottages that differ: use("dark wood"); for (let i = 0; i < 6; i++) { const h = 2 + random() * 1.5; box([i * 4, 0, 0], [3, h, 3]); use("roof tile"); box([i * 4 - 0.25, h, -0.25], [3.5, 0.5, 3.5]); use("dark wood"); }`,
};

/** The steps most builds need, for world_build's description; world_steps has the rest. */
export const COMMON_STEPS = `Steps run in order from a cursor at the origin (y = 0 is the floor). Common ones: {"voxel_size": 0.1}, {"use": "stone"}, {"material": "name", "color": "#rrggbb"}, {"at": [x, y, z]}, {"box": [w, h, d]} (from its corner), {"sphere": r}, {"cylinder": r, "height": h}, {"blob": [rx, ry, rz]}, {"extrude": {"points": [[x, z], …]}, "height": h}, {"path": [[x, z], …], "width": w}, {"place": "Palm tree", "at": [x, y, z], "turn": 30}. Shapes take "at" (from the cursor), "use", "erase": true, "hollow": true.
Code calls them as functions in map units, e.g. box([x, y, z], [w, h, d]), with random() and noise(), sealed off (no files or network).
Every other step, option and function, and the stock materials: world_steps.`;

// The Station in the classic look can't draw the world. A builder that wants to see it asks you to turn the
// voxel look on: always you (it changes how the Station looks in every project), once for builders asking together.
export function voxelLookRequest(ctx: ToolContext): ApprovalRequest {
  const agent = ctx.agent;
  return {
    kind: 'setting',
    title: `${agent.name} wants to see the voxel world`,
    detail: 'The Station is in the classic look, which doesn\'t draw the world your agents build. Turn on the voxel look (Settings › Appearance › Station look) so they can look at their work? It shows the world on the Station in every project and uses more graphics power; Settings › Appearance switches it back.',
    agentId: agent.id,
    agentName: agent.name,
    data: { setting: 'stationLook', value: 'world', allow: 'Turn on the voxel look', runId: ctx.runId },
  };
}

let askingForLook: Promise<boolean> | null = null;
function askForVoxelLook(ctx: ToolContext): Promise<boolean> {
  const ask = () => (ctx.approvalDecision || requestApproval)(voxelLookRequest(ctx))
    .then((d) => {
      if (d.approved) {
        saveSettings({ look: { stationLook: 'world' } });
        log('settings', `Turned on the voxel look for ${ctx.agent.name}`, { agentId: ctx.agent.id });
      }
      return d.approved;
    });
  if (ctx.approvalDecision) return ask();
  askingForLook ??= ask().finally(() => (askingForLook = null));
  return askingForLook;
}

/** How long a Station takes to switch to the voxel look and draw the world, at most (it is asked again meanwhile). */
export const LOOK_SWITCH_MS = 10_000;

/** The tools' own file checks (server/tools.ts): only the folders the agent may read or write. */
interface FileAccess {
  readable: (ctx: ToolContext, p: string | undefined) => string;
  writableDir: (ctx: ToolContext, p: string | undefined) => string;
}

interface WorldApprovalCheck {
  risk: Risk;
  name?: string;
  detail?: string;
  scope?: Record<string, unknown>;
  request?: ApprovalRequest;
}

function othersCheck(ctx: ToolContext, ref: unknown, doing: string, kind: 'object' | 'prefab' = 'object'): WorldApprovalCheck | null {
  const shown = shownWorld();
  if (!shown.world || shown.how === 'carried') return null;
  const target = kind === 'prefab' ? findPrefab(shown.world, ref) : findObject(shown.world, ref);
  if (!target || ownsObject(builderOf(ctx), target)) return null;
  return { name: 'world_change_others', risk: 'high', detail: `${ctx.agent.name} wants to ${doing} "${target.name}", which ${target.by.name} built.`, scope: { worldId: shown.world.id, kind, id: target.id, by: target.by } };
}

function skinCheck(ctx: ToolContext, args: ToolArgs): WorldApprovalCheck | null {
  const { to, id, hidden } = args;
  if (to !== 'agent' && to !== 'team' && to !== 'brain') return null;
  const target = skinTarget(to, to === 'agent' ? String(id || ctx.agent.id) : typeof id === 'string' ? id : undefined);
  const mine = to === 'agent' ? target.id === ctx.agent.id : to === 'team' ? (workflows.get(target.id)?.members || []).includes(ctx.agent.id) : false;
  return mine ? null : { name: 'world_skin_others', risk: 'high', detail: `${ctx.agent.name} wants to change how ${target.name} looks in the voxel world${hidden === true ? ' (take it off the map)' : ''}.`, scope: { worldId: shownWorld().world?.id || null, kind: to, id: target.id } };
}

/** The same ownership checks are used before the native wait and immediately before a change. */
export function worldApprovalChecks(name: string, args: ToolArgs, ctx: ToolContext): WorldApprovalCheck[] {
  let check: WorldApprovalCheck | null = null;
  switch (name) {
    case 'world_build':
      check = args.prefab ? othersCheck(ctx, args.prefab, 'change the prefab', 'prefab') : othersCheck(ctx, args.object, 'change');
      break;
    case 'world_object':
      if (args.duplicate !== true && args.delete !== true) check = othersCheck(ctx, args.object, 'change');
      break;
    case 'world_prefab':
      if (args.action === 'save' && args.replace) check = othersCheck(ctx, args.from, 'change');
      if (args.action === 'change') check = othersCheck(ctx, args.prefab, 'change the prefab', 'prefab');
      break;
    case 'world_animate':
      if (args.action === 'set' || args.action === 'remove') check = othersCheck(ctx, args.prefab, 'change the animations of', 'prefab');
      break;
    case 'world_skin':
      try { check = skinCheck(ctx, args); } catch { /* invalid targets fail in the tool */ }
      break;
    case 'world_look': {
      const world = shownWorld().world;
      const target = args.target || 'overview';
      if (!world || getSettings().look.stationLook === 'world' || !LOOK_TARGETS.includes(String(target) as WorldLookView['target'])) break;
      try {
        if (target === 'team' || target === 'agent') skinTarget(target, String(args.name || (target === 'agent' ? ctx.agent.id : '')));
        if (target === 'object' && !findObject(world, args.name) || target === 'prefab' && !findPrefab(world, args.name)) break;
        check = { risk: 'high', request: voxelLookRequest(ctx) };
      } catch { /* invalid targets fail in the tool */ }
      break;
    }
  }
  return check ? [check] : [];
}

export function worldTools(gate: Gate, files: FileAccess): ToolDef[] {
  // asks first when an agent changes what someone else built (the Brain and you never need to)
  const othersFirst = async (ctx: ToolContext, args: ToolArgs, ref: unknown, doing: string, kind: 'object' | 'prefab' = 'object'): Promise<ToolResult | null> => {
    const check = othersCheck(ctx, ref, doing, kind);
    return check ? gate(ctx.agent, check.name!, check.risk, args, { ...ctx, approvalScope: check.scope }, check.detail) : null;
  };

  return [
    {
      name: 'world_info',
      group: 'world',
      risk: 'none',
      description: "The voxel world in words: every object and prefab (who built it, where, how big), the look, recent changes, the map's layout (the Brain, team platforms, your plot) and what to keep clear. Call it before building.",
      parameters: obj({ map: str('An object or prefab to map from above'), voxel_size: num('With map: which of its voxel sizes') }),
      run: async ({ map, voxel_size }: { map?: string; voxel_size?: number }, ctx) => ({ text: worldInfo({ agentId: ctx.agent.id, map, size: voxel_size }) }),
    },
    {
      name: 'world_build',
      group: 'world',
      risk: 'low',
      description: `Build in the voxel world (${DIORAMA_TINY}) on an object, or with "prefab" on a prefab: a small model (a tree, a person, a lamp) made once and placed many times. Nothing comes ready-made. Give "steps", or "code": JavaScript for repetitive or procedural builds (cottages that each differ, branching trees, terrain from noise). A call works whole or changes nothing. Changing what another builder made asks the user first.\n${COMMON_STEPS}`,
      parameters: obj({
        object: str('The object to build on (a new name makes one)'),
        prefab: str('Or a prefab (a new name makes one), built around the origin on y = 0, front +z'),
        steps: { type: 'array', items: { type: 'object' } },
        code: str('Or JavaScript instead of steps'),
        description: str('Prefab: one line on what it is'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Prefab: words to find it by' },
        pivot: { description: 'Prefab: the point it turns around: "bottom" (default), "top" (an arm hangs from it), "center" or [x, y, z]' },
        anchor: str(`New object: ${ANCHOR} (default world)`),
        position: vec('New object: [x, y, z] map units from the anchor'),
        voxel_size: num("Starting voxel size (default: the world's, usually 0.25)"),
        units: oneOf(['map', 'voxels'], '"map" (recommended): steps in map units, like world_info\'s, not voxels'),
        seed: num('Another seed, another variation (code: default 1)'),
      }),
      // world_script was its own tool until code came into world_build: saved workflow steps still call it
      // (it never took steps: any it was sent were ignored, so they still are)
      aliases: [{ name: 'world_script', args: ({ steps: _ignored, ...rest }) => rest }],
      run: async (args, ctx) => {
        const a = args as { object?: string; prefab?: string; description?: unknown; tags?: unknown; pivot?: unknown; steps?: unknown; code?: unknown; anchor?: unknown; position?: unknown; voxel_size?: unknown; units?: unknown; seed?: unknown };
        // some models send every field, empty: those don't count
        const given = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
        const code = given(a.code);
        if (code && given(a.steps)) return { text: 'Give "steps" or "code", not both.', isError: true };
        if (!code && !given(a.steps)) return { text: 'Give "steps" (a list of build steps) or "code" (a JavaScript program).', isError: true };
        const refused = a.prefab ? await othersFirst(ctx, args, a.prefab, 'change the prefab', 'prefab') : await othersFirst(ctx, args, a.object, 'change');
        if (refused) return refused;
        try {
          const target = { by: builderOf(ctx), object: a.object, prefab: a.prefab, description: a.description, tags: a.tags, pivot: a.pivot, anchor: a.anchor, position: a.position, voxelSize: a.voxel_size };
          let printed: string[] = [];
          let r: ReturnType<typeof build>;
          if (code) {
            const qjs = await loadSandbox();
            const seed = a.seed === undefined ? 1 : Math.round(Number(a.seed)) || 1;
            r = build({ ...target, steps: [], drive: (api) => void (printed = runScript(qjs, String(a.code ?? ''), api, seed).log), seed });
          } else r = build({ ...target, steps: a.steps, units: a.units, seed: a.seed });
          log('world', `${ctx.agent.name} ${r.created ? 'built' : 'changed'} ${r.kind === 'prefab' ? 'the prefab ' : ''}"${r.object.name}" in the world${code ? ' with a script' : ''}`, { agentId: ctx.agent.id });
          return { text: `${r.text}${printed.length ? `\nThe script's log:\n${printed.join('\n')}` : ''}` };
        } catch (e) {
          return failed(e instanceof BuildError ? new Error(`Nothing was built. ${e.message}`) : e);
        }
      },
    },
    {
      name: 'world_steps',
      group: 'world',
      risk: 'none',
      description: "The full build reference, by topic: every step, option and function, stock materials, characters and animations. Look here before using anything world_build doesn't show.",
      parameters: obj({ topic: oneOf([...Object.keys(STEP_TOPICS), 'all']) }),
      run: async ({ topic }: { topic?: string }) => {
        const t = String(topic || 'all').trim().toLowerCase();
        if (t === 'all') return { text: Object.values(STEP_TOPICS).join('\n\n') };
        const text = STEP_TOPICS[t];
        return text ? { text } : { text: `No topic "${topic}". Topics: ${Object.keys(STEP_TOPICS).join(', ')}, or "all".`, isError: true };
      },
    },
    {
      name: 'world_object',
      group: 'world',
      // deleting is high; changing someone else's object asks too (see run)
      risk: ({ delete: del }: { delete?: boolean }) => (del === true ? 'high' : 'low'),
      description: 'Move, turn, scale, rename, hide, copy, re-anchor or delete an object in the voxel world. Only the fields you give change. world_undo brings a deleted one back.',
      parameters: obj(
        {
          object: str('Name or id'),
          name: str("A new name (with duplicate: the copy's)"),
          position: vec('[x, y, z] map units from its anchor'),
          move: vec('[dx, dy, dz] map units'),
          rotation: num('Degrees around the vertical'),
          scale: num('0.1 to 10'),
          anchor: str(ANCHOR),
          hidden: { type: 'boolean', description: 'false shows it again' },
          duplicate: { type: 'boolean', description: 'Copy it (to position, or by move)' },
          delete: { type: 'boolean' },
        },
        ['object'],
      ),
      run: async (args, ctx) => {
        const a = args as Record<string, unknown> & { object: string };
        // a delete was already asked about (its risk is high); asking again for someone else's would be twice
        if (a.duplicate !== true && a.delete !== true) {
          const refused = await othersFirst(ctx, args, a.object, 'change');
          if (refused) return refused;
        }
        try {
          // only the tool's own fields: which project's world it changes is never the model's to pick
          const r = changeObject({ by: builderOf(ctx), object: String(a.object ?? ''), name: a.name, position: a.position, move: a.move, rotation: a.rotation, scale: a.scale, anchor: a.anchor, hidden: a.hidden, duplicate: a.duplicate, delete: a.delete });
          log('world', `${ctx.agent.name}: ${r.text.split('.')[0]}`, { agentId: ctx.agent.id });
          return { text: r.text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_undo',
      group: 'world',
      risk: 'low',
      description: "Undo your last change in the voxel world (a build, a move, a delete); call again to go further back. It won't undo over someone else's later change.",
      parameters: obj({}),
      run: async (_args, ctx) => {
        try {
          return { text: undo(builderOf(ctx)).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_prefab',
      group: 'world',
      risk: ({ action }: { action?: string }) => (action === 'delete' ? 'high' : 'low'),
      description: 'Prefabs: small models made once and placed many times. "list": this world\'s, where each is used. "save": one from an object or a box of it. "change". "delete": only when no copy is placed. "publish": to the library every world shares. "library": search it. "import": take one from it. Build new ones with world_build "prefab".',
      parameters: obj(
        {
          action: oneOf(['list', 'save', 'change', 'delete', 'publish', 'library', 'import']),
          prefab: str('The prefab (name or id); save, import: the new name'),
          from: str('save: the object to take it from'),
          box: { type: 'object', description: 'save: {"min": [x, y, z], "max": [x, y, z]} map units from its origin (default: all of it)' },
          replace: { type: 'boolean', description: 'save: leave a copy of it where that part was' },
          name: str('change: a new name; import: the library prefab to take'),
          description: str('save, change: one line on what it is'),
          tags: { type: 'array', items: { type: 'string' }, description: 'save, change: words to find it by' },
          query: str('library: words to search for'),
          pivot: { description: 'change: "bottom", "top", "center" or [x, y, z]' },
        },
        ['action'],
      ),
      run: async (args, ctx) => {
        const a = args as { action?: string; prefab?: string; from?: string; box?: unknown; replace?: boolean; name?: string; description?: unknown; tags?: unknown; query?: string };
        const by = builderOf(ctx);
        try {
          const w = shownWorld().world;
          switch (a.action) {
            case 'list':
              return { text: w ? prefabList(w) : 'No world yet.' };
            case 'library':
              return { text: libraryList(a.query || '') };
            case 'save': {
              if (a.replace) {
                const refused = await othersFirst(ctx, args, a.from, 'change');
                if (refused) return refused;
              }
              return { text: savePrefabFrom({ by, name: String(a.prefab || a.name || ''), from: String(a.from || ''), box: a.box, description: a.description, tags: a.tags, replace: a.replace === true }).text };
            }
            case 'change': {
              const refused = await othersFirst(ctx, args, a.prefab, 'change the prefab', 'prefab');
              if (refused) return refused;
              return { text: changePrefab({ by, prefab: String(a.prefab || ''), name: a.name, description: a.description, tags: a.tags, pivot: (a as { pivot?: unknown }).pivot }).text };
            }
            case 'delete':
              return { text: deletePrefab({ by, prefab: String(a.prefab || '') }) };
            case 'publish':
              return { text: publishPrefab({ by, prefab: String(a.prefab || '') }) };
            case 'import':
              return { text: importPrefab({ by, name: String(a.name || a.prefab || ''), as: a.name && a.prefab ? a.prefab : undefined }).text };
            default:
              return { text: 'action is "list", "save", "change", "delete", "publish", "library" or "import".', isError: true };
          }
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_light',
      group: 'world',
      risk: ({ action }: { action?: string }) => (action === 'remove' ? 'high' : 'low'),
      description: `Add, change or remove a light in the voxel world. Glowing voxels (kind "emissive") already light their surroundings; add lights for what they can't, like light from a doorway, a spotlight or a fire's flicker. At most ${SCENE_LIMITS.lights}.`,
      parameters: obj(
        {
          action: oneOf(['add', 'change', 'remove']),
          light: str('change, remove: name or id'),
          name: { type: 'string' },
          kind: oneOf(['point', 'spot'], 'spot: a cone towards target'),
          color: str('#rrggbb (#ffb860 is warm lamplight)'),
          intensity: num('0-10: 1 a lantern, 4 a street lamp, 10 a floodlight'),
          range: num('Reach, map units'),
          anchor: str(ANCHOR),
          object: str(PIN),
          position: vec('[x, y, z] map units'),
          target: vec('spot: the point it shines at'),
          angle: num('spot: the cone, degrees'),
          flicker: num('0-1, for flames and old neon'),
        },
        ['action'],
      ),
      run: async (args, ctx) => {
        const { action, light, ...fields } = args as Record<string, unknown> & { action?: string; light?: string };
        if (action !== 'add' && action !== 'change' && action !== 'remove') return { text: 'action is "add", "change" or "remove".', isError: true };
        try {
          return { text: setLight({ by: builderOf(ctx), action, light, fields }).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_effect',
      group: 'world',
      risk: ({ action }: { action?: string }) => (action === 'remove' ? 'high' : 'low'),
      description: `Add, change or remove particles in an area of the voxel world (petals under blossom, fireflies over a pond, chimney smoke, mist on a river). Weather over the whole map: world_environment. At most ${SCENE_LIMITS.effects}.`,
      parameters: obj(
        {
          action: oneOf(['add', 'change', 'remove']),
          effect: str('change, remove: name or id'),
          kind: oneOf(EFFECT_KINDS),
          name: { type: 'string' },
          size: vec('The area [w, h, d], map units'),
          amount: num('0-1: how many'),
          colors: { type: 'array', items: { type: 'string' }, description: "#rrggbb colours (default: the kind's)" },
          wind: vec('[x, y, z] drift, map units a second'),
          anchor: str(ANCHOR),
          object: str(PIN),
          position: vec("[x, y, z] map units: the area's bottom centre"),
        },
        ['action'],
      ),
      run: async (args, ctx) => {
        const { action, effect, ...fields } = args as Record<string, unknown> & { action?: string; effect?: string };
        if (action !== 'add' && action !== 'change' && action !== 'remove') return { text: 'action is "add", "change" or "remove".', isError: true };
        try {
          return { text: setEffect({ by: builderOf(ctx), action, effect, fields }).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_environment',
      group: 'world',
      risk: 'low',
      description: 'The voxel world\'s time of day, sky, sun, fog, weather and wind: a preset, then any part, e.g. {"preset": "dusk", "sun": {"elevation": 8}, "weather": "snow"}. Match WORLD.md.',
      parameters: obj({
        preset: oneOf(Object.keys(ENV_PRESETS)),
        sky: { type: 'object', description: '{top, horizon, bottom}: #rrggbb' },
        sun: { type: 'object', description: '{color, intensity 0-8, azimuth and elevation 2-90 in degrees}' },
        fog: { type: 'object', description: '{color, density 0-1}' },
        ambient: { type: 'object', description: '{sky, ground (colours), intensity 0-4}' },
        bloom: num('0-2: glow around bright things'),
        tiltShift: num('0-1: the miniature blur'),
        exposure: num('0.3-3'),
        weather: oneOf(WEATHER),
        wind: vec('[x, y, z] map units a second'),
      }),
      run: async (args, ctx) => {
        try {
          return { text: setEnvironment({ by: builderOf(ctx), fields: args as Record<string, unknown> }).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_look',
      group: 'world',
      risk: 'none',
      description: 'A picture of the voxel world, or of one thing in it (the Brain, a team, an agent, an object, a prefab on its own), from any angle. Look after you build, and fix what looks wrong.',
      parameters: obj({
        target: oneOf(LOOK_TARGETS, 'Default overview'),
        name: str('The team, agent, object or prefab (name or id)'),
        azimuth: num('Degrees around (the Station looks from 45)'),
        elevation: num('Degrees up (the Station: 35; 90 is straight down)'),
        zoom: num('1 fits the target (default), 2 is twice as close'),
        save: { type: 'boolean', description: 'Also save the picture to Artifacts' },
      }),
      run: async (args, ctx) => {
        const a = args as { target?: string; name?: string; azimuth?: unknown; elevation?: unknown; zoom?: unknown };
        const shown = shownWorld();
        const w = shown.world;
        if (!w) return { text: 'There is no world yet: build something first.' };
        const target = (a.target || 'overview') as WorldLookView['target'];
        if (!LOOK_TARGETS.includes(target)) return { text: 'target is overview, brain, team, agent, object or prefab.', isError: true };
        let id: string | undefined;
        let label = target === 'overview' ? 'the whole world' : target === 'brain' ? 'the Brain' : '';
        try {
          if (target === 'team' || target === 'agent') {
            const t = skinTarget(target, a.name || (target === 'agent' ? ctx.agent.id : ''));
            id = t.id;
            label = t.name;
          } else if (target === 'object' || target === 'prefab') {
            const o = target === 'object' ? findObject(w, a.name) : findPrefab(w, a.name);
            if (!o) return { text: `There's no ${target} "${a.name || ''}". world_info lists them.`, isError: true };
            id = o.id;
            label = `${target === 'prefab' ? 'the prefab' : ''} "${o.name}"`.trim();
          }
        } catch (e) {
          return failed(e);
        }
        const n = (v: unknown, min: number, max: number) => (v === undefined || !Number.isFinite(Number(v)) ? undefined : Math.max(min, Math.min(max, Number(v))));
        const view: WorldLookView = { target, ...(id ? { id } : {}), azimuth: n(a.azimuth, -720, 720), elevation: n(a.elevation, 5, 90), zoom: n(a.zoom, 0.2, 8), width: 1024, height: 640 };
        let turnedOn = false;
        if (getSettings().look.stationLook !== 'world') {
          ctx.progress?.('Asking you to turn on the voxel look…');
          turnedOn = await askForVoxelLook(ctx);
          if (!turnedOn) return { text: `No picture: the user kept the Station in the classic look, which doesn't draw the voxel world. Don't ask again in this task.${target === 'object' || target === 'prefab' ? `\nHere is a map from above instead.\n${objectMap(w, id!)}` : '\nworld_info has where everything stands.'}` };
        }
        ctx.progress?.(`Looking at ${label}…`);
        let r = await requestLook(w.id, activeProject().id, view);
        // just switched: the open Stations are still loading the world, so ask again for a few seconds
        for (const until = Date.now() + LOOK_SWITCH_MS; turnedOn && !r.image && r.note !== 'no page is open' && Date.now() < until; ) {
          await new Promise((done) => setTimeout(done, 1500));
          r = await requestLook(w.id, activeProject().id, view);
        }
        if (r.image) {
          let saved = '';
          if ((a as { save?: boolean }).save === true) {
            const { addArtifact } = await import('../artifacts.ts');
            const file = writePicture(files.writableDir(ctx, 'pictures'), `${w.name} ${label}`, r.image);
            addArtifact({ title: `${cap(label)} in ${w.name}`, path: file, note: 'A picture of the voxel world', agentId: ctx.agent.id });
            saved = ` Saved to Artifacts: ${file}`;
          }
          return { text: `${cap(label)} in "${w.name}" (${w.environment.preset}${view.azimuth !== undefined ? `, from ${view.azimuth}°` : ''}).${saved}`, images: [r.image] };
        }
        // no picture: why, so the user can be asked for the right thing, and the next best thing
        const why =
          getSettings().look.stationLook !== 'world'
            ? 'the Station is in the classic look, which doesn\'t draw the voxel world. Ask the user to turn on Settings › Appearance › Station look › Voxel world.'
            : r.note === 'no page is open'
              ? 'the dashboard isn\'t open in any window. Ask the user to open the Station.'
              : `no open Station could draw it (${r.note || 'no answer'}). Ask the user to open the Station with this project open.`;
        const map = target === 'object' || target === 'prefab' ? `\nHere is a map from above instead.\n${objectMap(w, id!)}` : '\nworld_info has where everything stands in the meantime.';
        return { text: `No picture: ${why}${map}` };
      },
    },
    {
      name: 'world_import',
      group: 'world',
      risk: 'low',
      description: 'Bring a MagicaVoxel .vox file into the voxel world as a prefab (to place copies of) or an object. It must be in a folder you may read.',
      parameters: obj(
        {
          file: str('The .vox file'),
          as: oneOf(['prefab', 'object'], 'Default "prefab"'),
          name: str("Its name in the world (default: the file's)"),
          voxel_size: num("Map units per voxel (default 0.1 for a prefab, the world's for an object)"),
          anchor: str(`object: ${ANCHOR}`),
          position: vec('object: [x, y, z] map units'),
        },
        ['file'],
      ),
      run: async (args, ctx) => {
        const a = args as { file?: string; as?: string; name?: string; voxel_size?: unknown; anchor?: unknown; position?: unknown };
        try {
          const file = files.readable(ctx, a.file);
          return { text: importVox({ by: builderOf(ctx), file, as: a.as === 'object' ? 'object' : 'prefab', name: String(a.name || ''), voxelSize: a.voxel_size, anchor: a.anchor, position: a.position }) };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_export',
      group: 'world',
      risk: 'low',
      description: 'Save an object, a prefab or the whole voxel world to Artifacts as "glb" (a glTF 3D model for Blender, game engines, the web) or "vox" (MagicaVoxel: a file per voxel size, no placed copies, not the whole world).',
      parameters: obj(
        {
          what: oneOf(['object', 'prefab', 'world']),
          name: str('The object or prefab (name or id)'),
          format: oneOf(['glb', 'vox'], 'Default "glb"'),
        },
        ['what'],
      ),
      run: async (args, ctx) => {
        const a = args as { what?: string; name?: string; format?: string };
        const w = shownWorld().world;
        if (!w) return { text: 'There is no world yet.', isError: true };
        if (a.what !== 'object' && a.what !== 'prefab' && a.what !== 'world') return { text: 'what is "object", "prefab" or "world".', isError: true };
        try {
          const out = exportFiles(w, a.what, a.name, a.format === 'vox' ? 'vox' : 'glb');
          const paths = writeFiles(files.writableDir(ctx, 'exports'), out.files);
          const { addArtifact } = await import('../artifacts.ts');
          for (const p of paths) addArtifact({ title: out.files.length > 1 ? `${out.title}: ${p.split(/[\\/]/).pop()}` : out.title, path: p, note: out.note || 'Made from the voxel world', agentId: ctx.agent.id });
          return { text: `Saved ${paths.join(', ')} (${out.files.map((f) => `${Math.round(f.bytes.length / 1024)} KB`).join(', ')}) and added ${paths.length > 1 ? 'them' : 'it'} to Artifacts.${out.note ? ` ${out.note}` : ''}` };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_skin',
      group: 'world',
      // dressing yourself or your own team is yours to do; anyone else, or the Brain, asks first (see run)
      risk: 'low',
      description: 'Dress an agent, a team or the Brain in the voxel world with prefabs, or take them off the map. Only the fields you give change. You and your own team need no OK; anyone else, or the Brain, asks the user first.',
      parameters: obj(
        {
          to: oneOf(['agent', 'team', 'brain']),
          id: str('The agent (default: you) or team, by name or id'),
          character: str('agent: the prefab whose form it takes'),
          desk: str('agent: a prefab (the live screen stays)'),
          states: { type: 'object', description: 'agent: {"idle", "working", "needs"}: the clip each plays' },
          platform: str('team: a prefab'),
          hub: str('team: a prefab for its middle'),
          shell: str('brain: a prefab around it'),
          globe: { type: 'boolean', description: 'brain: false hides the particle globe' },
          offset: vec('[x, y, z] map units from the classic spot'),
          turn: num('Degrees around the vertical'),
          scale: num('0.1 to 10'),
          hidden: { type: 'boolean', description: 'Off the map (it still works; its name opens it)' },
          label: { type: 'boolean', description: 'false hides its name too' },
          clear: { type: 'boolean', description: 'Back to the classic look' },
        },
        ['to'],
      ),
      run: async (args, ctx) => {
        const { to, id, ...fields } = args as Record<string, unknown> & { to?: string; id?: string };
        try {
          if (to !== 'agent' && to !== 'team' && to !== 'brain') return { text: 'to is "agent", "team" or "brain".', isError: true };
          const target = skinTarget(to, to === 'agent' ? id || ctx.agent.id : id);
          const check = skinCheck(ctx, args);
          if (check) {
            const refused = await gate(ctx.agent, check.name!, check.risk, args, { ...ctx, approvalScope: check.scope }, check.detail);
            if (refused) return refused;
          }
          return { text: setSkin({ by: builderOf(ctx), to, id: target.id, fields }).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_animate',
      group: 'world',
      risk: 'low',
      description: 'Design the animations of a character prefab (the form an agent takes), or play one. Its named parts turn around their pivots; "self" moves all of it, so a prefab without parts moves too. Clips named "idle", "working" and "needs" play while the agent is idle, working or waiting for the user. "list": its parts and clips. "play": once on an agent wearing it. Example: world_steps "characters".',
      parameters: obj(
        {
          action: oneOf(['set', 'remove', 'list', 'play']),
          prefab: str('The character prefab (set, remove, list)'),
          clip: str("The animation's name"),
          duration: num('set: seconds'),
          loop: { type: 'boolean', description: 'set: loop (default true)' },
          tracks: { type: 'object', description: 'set: {"part name" or "self": [{"t": 0 to 1, "turn": [x, y, z] degrees, "move": [x, y, z] map units, "scale", "ease": "linear|smooth|step|bounce"}, …]}' },
          agent: str('play: the agent (name or id; default: you)'),
          times: num('play: how many times (default 1)'),
        },
        ['action'],
      ),
      run: async (args, ctx) => {
        const a = args as { action?: string; prefab?: string; clip?: string; duration?: unknown; loop?: unknown; tracks?: unknown; agent?: string; times?: unknown };
        try {
          if (a.action === 'play') return { text: playAnimation({ by: builderOf(ctx), agent: a.agent || ctx.agent.id, clip: String(a.clip || ''), times: a.times }) };
          if (a.action !== 'set' && a.action !== 'remove' && a.action !== 'list') return { text: 'action is "set", "remove", "list" or "play".', isError: true };
          if (a.action !== 'list') {
            const refused = await othersFirst(ctx, args, a.prefab, 'change the animations of', 'prefab');
            if (refused) return refused;
          }
          return { text: setAnimation({ by: builderOf(ctx), prefab: String(a.prefab || ''), action: a.action, clip: a.clip, fields: { duration: a.duration, loop: a.loop, tracks: a.tracks } }).text };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_md_read',
      group: 'world',
      risk: 'none',
      description: 'Read the whole WORLD.md as it is now (your instructions have it as it was when this chat started, maybe cut short).',
      parameters: obj({}),
      run: async (_args, ctx) => {
        const w = shownWorld().world;
        if (!w) return { text: 'There is no world yet: your first world_build starts one, with a WORLD.md to fill in.' };
        mdRead.set(readKey(ctx, w.id), worldMdStamp(w.id));
        return { text: readWorldMd(w.id) };
      },
    },
    {
      name: 'world_md_section',
      group: 'world',
      risk: 'low',
      description: "Replace one section of WORLD.md, or add to its end. A section that isn't there yet is added. The earlier version is kept.",
      parameters: obj(
        {
          section: str('Its heading, or a path: "Places › Koi pond"'),
          content: str("Markdown: the section's new text, or what append adds"),
          append: { type: 'boolean', description: 'Add to the end instead of replacing' },
        },
        ['section', 'content'],
      ),
      run: async ({ section, content, append }: { section: string; content: string; append?: boolean }, ctx) => {
        const w = shownWorld().world;
        if (!w || shownWorld().how === 'carried') return { text: "This project has no world of its own yet: build something first (it makes this project's world), then write its WORLD.md.", isError: true };
        try {
          // only a builder that had read the version it changed has read the result (it never sees the rest)
          const key = readKey(ctx, w.id);
          const fresh = mdRead.has(key) && mdRead.get(key) === worldMdStamp(w.id);
          const r = withActor('agent', () => writeWorldMdSection(w.id, String(section), content, append === true));
          if (fresh) mdRead.set(key, r.updatedAt);
          return { text: `Saved WORLD.md (${r.text.length.toLocaleString('en-US')} characters).` };
        } catch (e) {
          return failed(e);
        }
      },
    },
    {
      name: 'world_md_write',
      group: 'world',
      risk: 'low',
      description: 'Replace the whole WORLD.md, over the version you read with world_md_read in this chat. For one section use world_md_section. The earlier version is kept.',
      parameters: obj({ content: str('The whole new WORLD.md (Markdown)') }, ['content']),
      run: async ({ content }: { content: string }, ctx) => {
        const w = shownWorld().world;
        if (!w || shownWorld().how === 'carried') return { text: "This project has no world of its own yet: build something first (it makes this project's world), then write its WORLD.md.", isError: true };
        const seen = mdRead.get(readKey(ctx, w.id));
        if (seen === undefined) return { text: 'Read WORLD.md with world_md_read first, so nothing in it is lost.', isError: true };
        if (seen !== worldMdStamp(w.id)) return { text: 'WORLD.md changed since you read it. Read it again with world_md_read, then write.', isError: true };
        try {
          const r = withActor('agent', () => writeWorldMd(w.id, content));
          mdRead.set(readKey(ctx, w.id), r.updatedAt);
          return { text: `Saved WORLD.md (${r.text.length.toLocaleString('en-US')} characters).` };
        } catch (e) {
          return failed(e);
        }
      },
    },
  ];
}

/** For a builder's instructions: the world's WORLD.md (only for agents with the world tools). */
export function worldPrompt(toolNames: string[]): string {
  if (!toolNames.includes('world_build')) return '';
  const shown = shownWorld();
  if (!shown.world) return `\n# The voxel world\n${DIORAMA}\n${BUILD_ORDER}\nThere is no world yet. Your first world_build starts this project's world; then fill in its WORLD.md (world_md_section) with what it is. ${KEEP_WORLD_MD}`;
  return worldMdContext(shown.world.id, shown.world.name);
}

export { VERBS };
