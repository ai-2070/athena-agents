// The agents' voxel world tools (the "world" tool group). Building only touches the dashboard's own world
// and can be undone, so it is low risk; changing or deleting what someone else built asks first (high).
import { log } from '../store.ts';
import { withActor } from '../versions.ts';
import { VERBS, BuildError } from './ops.ts';
import { build, changeObject, findObject, findPrefab, ownsObject, undo } from './build.ts';
import { changePrefab, deletePrefab, importPrefab, libraryList, prefabList, publishPrefab, savePrefabFrom } from './prefabs.ts';
import { shownWorld } from './link.ts';
import { worldInfo } from './describe.ts';
import { readWorldMd, worldMdStamp, writeWorldMd, writeWorldMdSection, worldMdContext } from './worldmd.ts';
import type { JSONSchema, Risk, ToolArgs, ToolContext, ToolDef, ToolResult, ToolRunInfo, ToolAgent } from '../tools.ts';
import type { WorldBuilder } from '../../shared/types.ts';

type Gate = (agent: ToolAgent, name: string, risk: Risk, args: ToolArgs, ctx?: ToolRunInfo, detail?: string | null) => Promise<ToolResult | null>;

const str = (description: string): JSONSchema => ({ type: 'string', description });
const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', properties, required });
const builderOf = (ctx: ToolContext): WorldBuilder => ({ kind: 'agent', id: ctx.agent.id, name: ctx.agent.name });
const failed = (e: unknown): ToolResult => ({ text: e instanceof Error ? e.message : String(e), isError: true });

// WORLD.md reads in a run, so a whole rewrite is only made over the version the agent saw.
const mdRead = new Map<string, number>();
const readKey = (ctx: ToolContext, worldId: string) => `${ctx.runId || ctx.agent.id}:${worldId}`;

/** The build language, as the model sees it in world_build. */
export const STEPS_HELP = `Steps run in order on one object (or one prefab). Positions are whole voxels of the current voxel size, from the cursor (start: the origin, y = 0 is the floor). Map units: a desk is 2.6 wide, a person 1.7 tall.
State: {"voxel_size": 0.1} (the next steps build at that size; one object can mix sizes), {"use": "stone"}, {"material": "name", "color": "#rrggbb", "ramp": ["#..", "#.."], "jitter": 0.08, "kind": "solid|glass|water|emissive|metal|leaf|snow", "emissive": 3, "opacity": 0.6} (define or change a material, then use it), {"at": [x, y, z]} (move the cursor; "units": "map" for map units), {"move": [dx, dy, dz]}, {"mirror": "x"} (or ["x", "z"], "none": mirror the following steps across the cursor), {"seed": 7}.
Shapes (each may take "at": offset from the cursor, "use": material, "erase": true, "keep": true to fill only empty voxels, "hollow": true):
{"box": [w, h, d]} (from its corner; "frame": true for edges only), {"sphere": r}, {"ellipsoid": [rx, ry, rz]}, {"blob": [rx, ry, rz], "rough": 0.3, "holes": 0.2} (organic: crowns, bushes, clouds, rocks), {"cylinder": r, "height": h, "axis": "y"}, {"cone": r, "height": h, "down": false}, {"pyramid": [w, d], "height": h}, {"torus": R, "tube": r}, {"line": [x, y, z], "thickness": 1} (to that point), {"stairs": {"steps": n, "width": w, "dir": "+x", "rise": 1, "run": 1}}, {"arch": {"width": w, "height": h, "thickness": 1, "depth": 1, "axis": "x"}}, {"set": [[x, y, z], …]}, {"layers": [["row", …] (bottom layer first; each row runs along x, rows along z)], "key": {"#": "stone", "o": "lantern"}} ("." is empty), {"text": "DINER", "facing": "+z", "scale": 1, "depth": 1}, {"heightmap": {"rows": ["0123", …]} or {"size": [w, d], "height": 6, "cell": 12}, "top": "grass"}, {"replace": {"from": "stone", "to": "moss", "chance": 0.3}, "in": [w, h, d]}, {"clear": true} (everything at this voxel size), {"scatter": {"count": 20, "area": [w, d], "step": {…any step…}}}.
Shape tools: {"revolve": [[radius, height], …], "sides": 0} (a profile turned around the vertical: columns, domes, vases, trunks, minarets; "sides": 4 for square, 8 for octagonal), {"extrude": {"points": [[x, z], …]} or {"rows": ["##..", …]}, "height": h, "wall": 1} (an outline raised: floor plans, walls, plazas, fields; "wall" for hollow walls that thick), {"path": [[x, z] or [x, y, z], …], "width": w, "height": 1} (a brush swept along points: roads, rivers, canals, walls).
Region tools (a box of w×h×d voxels): {"copy": [w, h, d], "from": [x, y, z], "at": [x, y, z], "turn": 90, "mirror": "x"}, {"shift": [w, h, d], "from": […], "at": […]} (move it), {"rotate": [w, h, d], "at": […], "turn": 90} (in place), {"flip": [w, h, d], "at": […], "axis": "x"}.
Prefabs (small models made once and used many times; see world_prefab):
{"place": "Palm tree", "at": [x, y, z], "turn": 30} places one copy (any angle; "tilt"/"roll" 0/90/180/270, "scale", "mirror": true, "swap": {"shirt": "cloth red"} to recolour a material in that copy). Many at once: "scatter": {"area": [w, d], "count": 60, "spacing": 6}, or "along": [[x, z], …] with "every": 12, "sides": 2, "offset": 4, "face": "along"|"across", or "grid": {"rows": 3, "cols": 5, "gap": [6, 8]}. "place" can be a list of prefabs to pick from, "turn": "random" or [min, max], "scale": [min, max], "mirror": "random", "swap": a list to pick from. Many copies stand on what is built below them ("on": "surface"); a single one stands exactly at "at" unless "on": "surface". "avoid": "solid" skips spots inside something built.
{"unplace": "Palm tree" (or a list, or "all"), "in": [w, h, d]} takes copies away. {"stamp": "Window", "at": [x, y, z], "turn": 90, "swap": {…}} bakes a prefab into this object's voxels (quarter turns), for parts of a building.
Stock materials (by name, no need to define): grass, moss, dirt, sand, stone, dark stone, cobble, brick, white plaster, wood, dark wood, bark, leaves, pine needles, blossom, autumn leaves, bamboo, water, glass, ice, snow, cloud, red lacquer, roof tile, gold, iron, lantern, neon pink, neon blue, fire, cloth white, skin light, skin medium, skin dark.`;

export function worldTools(gate: Gate): ToolDef[] {
  // asks first when an agent changes what someone else built (the Brain and you never need to)
  const othersFirst = async (ctx: ToolContext, args: ToolArgs, ref: unknown, doing: string, kind: 'object' | 'prefab' = 'object'): Promise<ToolResult | null> => {
    const shown = shownWorld();
    if (!shown.world || shown.how === 'carried') return null;
    const o = kind === 'prefab' ? findPrefab(shown.world, ref) : findObject(shown.world, ref);
    if (!o || ownsObject(builderOf(ctx), o)) return null;
    return gate(ctx.agent, 'world_change_others', 'high', args, ctx, `${ctx.agent.name} wants to ${doing} "${o.name}", which ${o.by.name} built.`);
  };

  return [
    {
      name: 'world_info',
      group: 'world',
      risk: 'none',
      description: "The voxel world in words: its name, look, palette, every object (who built it, where, how big), recent changes, the map's layout (the Brain, team platforms, your team's plot) and what to keep clear. Pass map=<object name> for a top-down map of that object. Call it before building.",
      parameters: obj({ map: str('Optional: an object to map from above'), voxel_size: { type: 'number', description: 'Optional, with map: which of its voxel sizes to map' } }),
      run: async ({ map, voxel_size }: { map?: string; voxel_size?: number }, ctx) => ({ text: worldInfo({ agentId: ctx.agent.id, map, size: voxel_size }) }),
    },
    {
      name: 'world_build',
      group: 'world',
      risk: 'low',
      description: `Build in the voxel world: run build steps on an object (made if there is no object by that name yet), or with "prefab" on a prefab: a small model (a palm tree, a person, a taxi, a lamp) you make once and then place many times with {"place": …}. Everything in the world is built by you and the other builders: nothing comes ready-made. Read WORLD.md and world_info first and build in the world's style; anchor things to your team ("team:<id>") so they move with its platform. A call can change up to 250,000 voxels and place 2,000 copies, and either works whole or changes nothing. Changing another builder's object or prefab asks the user first.\n${STEPS_HELP}`,
      parameters: obj(
        {
          object: str('The object to build or add to, by name (a new name makes a new object), e.g. "Koi pond". Leave out when building a prefab.'),
          prefab: str('Build this prefab instead of an object (a new name makes a new one), e.g. "Palm tree". Build it around the origin, standing on y = 0: its bottom centre is the spot copies stand on, and +z is its front.'),
          description: str('A prefab: one line saying what it is'),
          tags: { type: 'array', items: { type: 'string' }, description: 'A prefab: words to find it by' },
          steps: { type: 'array', items: { type: 'object' }, description: 'The build steps, in order' },
          anchor: str('New objects: what it is pinned to: "world", "brain", "team:<team id>" or "agent:<agent id>" (default "world")'),
          position: { type: 'array', items: { type: 'number' }, description: 'New objects: [x, y, z] in map units from the anchor (default [0, 0, 0])' },
          voxel_size: { type: 'number', description: "The voxel size the steps start with, in map units (default: the world's, usually 0.25). Change it in the steps with {\"voxel_size\": …}." },
          seed: { type: 'number', description: 'Optional: another seed gives another variation of the same steps' },
        },
        ['steps'],
      ),
      run: async (args, ctx) => {
        const a = args as { object?: string; prefab?: string; description?: unknown; tags?: unknown; steps: unknown; anchor?: unknown; position?: unknown; voxel_size?: unknown; seed?: unknown };
        const refused = a.prefab ? await othersFirst(ctx, args, a.prefab, 'change the prefab', 'prefab') : await othersFirst(ctx, args, a.object, 'change');
        if (refused) return refused;
        try {
          const r = build({ by: builderOf(ctx), object: a.object, prefab: a.prefab, description: a.description, tags: a.tags, steps: a.steps, anchor: a.anchor, position: a.position, voxelSize: a.voxel_size, seed: a.seed });
          log('world', `${ctx.agent.name} ${r.created ? 'built' : 'changed'} ${r.kind === 'prefab' ? 'the prefab ' : ''}"${r.object.name}" in the world`, { agentId: ctx.agent.id });
          return { text: `${r.text}${r.kind === 'object' ? '\nIf this made a new place or changed a character, update WORLD.md (world_md_section) and add a line to "Story so far".' : ''}` };
        } catch (e) {
          return failed(e instanceof BuildError ? new Error(`Nothing was built. ${e.message}`) : e);
        }
      },
    },
    {
      name: 'world_object',
      group: 'world',
      // deleting is high; changing someone else's object asks too (see run)
      risk: ({ delete: del }: { delete?: boolean }) => (del === true ? 'high' : 'low'),
      description: 'Move, turn, scale, rename, hide or show, copy, re-anchor or delete an object in the voxel world. Only the fields you give change. A deleted object can be brought back with world_undo.',
      parameters: obj(
        {
          object: str('The object, by name or id'),
          name: str('A new name (or, with duplicate, the copy\'s name)'),
          position: { type: 'array', items: { type: 'number' }, description: '[x, y, z] in map units from its anchor' },
          move: { type: 'array', items: { type: 'number' }, description: '[dx, dy, dz] in map units' },
          rotation: { type: 'number', description: 'Degrees around the vertical' },
          scale: { type: 'number', description: '0.1 to 10' },
          anchor: str('"world", "brain", "team:<id>" or "agent:<id>"'),
          hidden: { type: 'boolean', description: 'Hide it (true) or show it again (false)' },
          duplicate: { type: 'boolean', description: 'Make a copy (with position or move for where)' },
          delete: { type: 'boolean', description: 'Delete it' },
        },
        ['object'],
      ),
      run: async (args, ctx) => {
        const a = args as Record<string, unknown> & { object: string };
        if (a.duplicate !== true) {
          const refused = await othersFirst(ctx, args, a.object, a.delete === true ? 'delete' : 'change');
          if (refused) return refused;
        }
        try {
          const r = changeObject({ ...a, by: builderOf(ctx) });
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
      description: "Undo your last change in the voxel world (a build, a move, a delete). Call it again to go further back. It won't undo over someone else's later change to the same object.",
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
      description: 'Prefabs: small models made once and placed many times (people, trees, lamps, cars, boats, stalls, windows). Actions: "list" (this world\'s prefabs, where they are used), "save" (make a prefab from an object, or a box of it, in map units from its origin; "replace": true turns that part into a copy of the new prefab), "change" (name, description, tags), "delete" (only when no copy is placed), "publish" (share it with every world and project in the prefab library), "library" (what is in the library; "query" to search), "import" (take one from the library into this world). Build a new prefab with world_build and "prefab"; place copies with the "place" step.',
      parameters: obj(
        {
          action: str('"list", "save", "change", "delete", "publish", "library" or "import"'),
          prefab: str('The prefab (name or id); for save and import, the new name'),
          from: str('save: the object to take it from'),
          box: { type: 'object', description: 'save: {"min": [x, y, z], "max": [x, y, z]} in map units from the object\'s origin (default: all of it)' },
          replace: { type: 'boolean', description: 'save: put a copy of the new prefab where that part was' },
          name: str('change: a new name; import: the library prefab to take'),
          description: str('save, change: one line saying what it is'),
          tags: { type: 'array', items: { type: 'string' }, description: 'save, change: words to find it by' },
          query: str('library: words to search for'),
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
              return { text: changePrefab({ by, prefab: String(a.prefab || ''), name: a.name, description: a.description, tags: a.tags }).text };
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
      name: 'world_md_read',
      group: 'world',
      risk: 'none',
      description: "Read the world's WORLD.md as it is now: its theme and meaning, look, feel, places, characters, story and rules (your instructions have it as it was when this chat started, maybe cut short).",
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
      description: 'Change one section of WORLD.md: replace it, or add to its end with append. Name it by its heading, or a path of headings: "Places › Koi pond", "Characters › Mira", "Story so far". A section that isn\'t there yet is added. Use this after you build a place or dress a character, and add one line to "Story so far" (append) after each build. The earlier version is kept.',
      parameters: obj(
        {
          section: str('The heading, or a path: "Places › Koi pond"'),
          content: str('The new text of the section (Markdown), or with append the text to add'),
          append: { type: 'boolean', description: 'Add to the end of the section instead of replacing it' },
        },
        ['section', 'content'],
      ),
      run: async ({ section, content, append }: { section: string; content: string; append?: boolean }, ctx) => {
        const w = shownWorld().world;
        if (!w || shownWorld().how === 'carried') return { text: "This project has no world of its own yet: build something first (it makes this project's world), then write its WORLD.md.", isError: true };
        try {
          const r = withActor('agent', () => writeWorldMdSection(w.id, String(section), content, append === true));
          mdRead.set(readKey(ctx, w.id), r.updatedAt);
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
      description: 'Replace the whole WORLD.md (Markdown). Read it with world_md_read first in this chat: a rewrite over a version you haven\'t seen is refused. For one section, use world_md_section instead. The earlier version is kept.',
      parameters: obj({ content: str('The whole new WORLD.md') }, ['content']),
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
  if (!shown.world) return '\n# The voxel world\nThere is no world yet. Your first world_build starts this project\'s world; then fill in its WORLD.md (world_md_section) with what it is.';
  return worldMdContext(shown.world.id, shown.world.name);
}

export { VERBS };
