// The agents' voxel world tools (the "world" tool group). Building only touches the dashboard's own world
// and can be undone, so it is low risk; changing or deleting what someone else built asks first (high).
import { log } from '../store.ts';
import { withActor } from '../versions.ts';
import { GENERATORS } from './generators/index.ts';
import { VERBS, BuildError } from './ops.ts';
import { build, changeObject, findObject, ownsObject, undo } from './build.ts';
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
export const STEPS_HELP = `Steps run in order on one object. Positions are whole voxels of the current voxel size, from the cursor (start: the object's origin, y = 0 is the floor). Generator sizes are in map units (a desk is 2.6 wide, a person 1.7 tall), so the same tree comes out finer at a smaller voxel size.
State: {"voxel_size": 0.1} (the next steps build at that size; one object can mix sizes), {"use": "stone"}, {"material": "name", "color": "#rrggbb", "ramp": ["#..", "#.."], "jitter": 0.08, "kind": "solid|glass|water|emissive|metal|leaf|snow", "emissive": 3, "opacity": 0.6} (define or change a material, then use it), {"at": [x, y, z]} (move the cursor; "units": "map" for map units), {"move": [dx, dy, dz]}, {"mirror": "x"} (or ["x", "z"], "none": mirror the following steps across the cursor), {"seed": 7}.
Shapes (each may also take "at": offset from the cursor, "use": material, "erase": true, "keep": true to fill only empty voxels, "hollow": true):
{"box": [w, h, d]} (from its corner; "frame": true for edges only), {"sphere": r}, {"ellipsoid": [rx, ry, rz]}, {"cylinder": r, "height": h, "axis": "y"}, {"cone": r, "height": h, "down": false}, {"pyramid": [w, d], "height": h}, {"torus": R, "tube": r}, {"line": [x, y, z], "thickness": 1} (to that point), {"stairs": {"steps": n, "width": w, "dir": "+x", "rise": 1, "run": 1}}, {"arch": {"width": w, "height": h, "thickness": 1, "depth": 1, "axis": "x"}}, {"set": [[x, y, z], …]}, {"layers": [["row", …] (bottom layer first; each row runs along x, rows along z)], "key": {"#": "stone", "o": "lantern"}} ("." is empty), {"text": "DINER", "facing": "+z", "scale": 1, "depth": 1}, {"heightmap": {"rows": ["0123", …]} or {"size": [w, d], "height": 6, "cell": 12}, "top": "grass"}, {"replace": {"from": "stone", "to": "moss", "chance": 0.3}, "in": [w, h, d]}, {"clear": true} (everything at this voxel size), {"scatter": {"count": 20, "area": [w, d], "step": {"tree": {"kind": "pine"}}}}.
Stock materials (use by name, no need to define): grass, moss, dirt, sand, stone, dark stone, cobble, brick, white plaster, wood, dark wood, bark, leaves, pine needles, blossom, autumn leaves, bamboo, water, glass, ice, snow, cloud, red lacquer, roof tile, gold, iron, lantern, neon pink, neon blue, fire, cloth white, skin light, skin medium, skin dark.`;

const generatorsHelp = () => Object.values(GENERATORS).map((g) => `{"${g.help.split(':')[0]}": {…}}: ${g.help.slice(g.help.indexOf(':') + 1).trim()}`).join('\n');

export function worldTools(gate: Gate): ToolDef[] {
  // asks first when an agent changes what someone else built (the Brain and you never need to)
  const othersFirst = async (ctx: ToolContext, args: ToolArgs, ref: unknown, doing: string): Promise<ToolResult | null> => {
    const shown = shownWorld();
    if (!shown.world || shown.how === 'carried') return null;
    const o = findObject(shown.world, ref);
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
      description: `Build in the voxel world: run build steps on an object, made if there is no object by that name yet. Read WORLD.md and world_info first and build in the world's style; anchor things to your team ("team:<id>") so they move with its platform. Use generators for big things and shapes or layers for details; a call can change up to 250,000 voxels and either works whole or changes nothing. Changing another builder's object asks the user first.\n${STEPS_HELP}\nGenerators (at the cursor; sizes in map units):\n${generatorsHelp()}`,
      parameters: obj(
        {
          object: str('The object to build or add to, by name (a new name makes a new object), e.g. "Koi pond"'),
          steps: { type: 'array', items: { type: 'object' }, description: 'The build steps, in order' },
          anchor: str('New objects: what it is pinned to: "world", "brain", "team:<team id>" or "agent:<agent id>" (default "world")'),
          position: { type: 'array', items: { type: 'number' }, description: 'New objects: [x, y, z] in map units from the anchor (default [0, 0, 0])' },
          voxel_size: { type: 'number', description: "The voxel size the steps start with, in map units (default: the world's, usually 0.25). Change it in the steps with {\"voxel_size\": …}." },
          seed: { type: 'number', description: 'Optional: another seed gives another variation of the same steps' },
        },
        ['object', 'steps'],
      ),
      run: async (args, ctx) => {
        const a = args as { object: string; steps: unknown; anchor?: unknown; position?: unknown; voxel_size?: unknown; seed?: unknown };
        const refused = await othersFirst(ctx, args, a.object, 'change');
        if (refused) return refused;
        try {
          const r = build({ by: builderOf(ctx), object: a.object, steps: a.steps, anchor: a.anchor, position: a.position, voxelSize: a.voxel_size, seed: a.seed });
          log('world', `${ctx.agent.name} ${r.created ? 'built' : 'changed'} "${r.object.name}" in the world`, { agentId: ctx.agent.id });
          return { text: `${r.text}\nIf this made a new place or changed a character, update WORLD.md (world_md_section) and add a line to "Story so far".` };
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
