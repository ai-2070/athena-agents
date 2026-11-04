// How much of every model request the tool list takes: each group stays under its budget.
// Measured as the model gets it: name, description and input schema, as JSON.
import { describe, expect, it } from 'vitest';
import { TOOL_GROUPS, allTools, toolDefs } from '../../server/tools.ts';

const size = (t: { name: string; description: string; parameters: unknown }) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters }).length;
const everything = { id: 'budget', name: 'Budget', toolGroups: TOOL_GROUPS.map((g) => g.id) };
const groupOf = new Map(allTools().map((t) => [t.name, t.group]));

function sizes() {
  const by = new Map<string, number>();
  // (an Eve agent with every group, in a board task and a gateway conversation, sees every tool there is)
  const seen = new Map([...toolDefs(everything, { engine: 'eve', conversationId: 'board-x' }), ...toolDefs(everything, { engine: 'eve', conversationId: 'a'.repeat(64) })].map((t) => [t.name, t]));
  for (const t of seen.values()) by.set(groupOf.get(t.name)!, (by.get(groupOf.get(t.name)!) || 0) + size(t));
  const core = toolDefs({ id: 'plain', name: 'Plain', toolGroups: [] }).reduce((n, t) => n + size(t), 0);
  return { by, core, total: [...seen.values()].reduce((n, t) => n + size(t), 0) };
}

// Characters. Lower these when a change makes the tools smaller; raise one only on purpose.
// (comfyui went from 1 500 to 2 450 when comfyui_run learned to send input pictures and masks)
const BUDGET: Record<string, number> = {
  world: 15_600, core: 13_800, social: 5_100, files: 3_300, comfyui: 2_450, agents: 2_300, media: 2_000, assets: 1_750,
  cad: 1_500, substance: 1_450, adobe: 1_200, programs: 1_050, nvidia: 1_000, browser: 1_000, memory: 950, maya: 950,
  houdini: 900, blender: 900, shell: 500, orca: 300, knowledge: 600,
};
// what every agent carries in every request, outside board tasks and gateways (it was 15 969 characters)
const PLAIN_CORE = 12_200;

describe('tool list size', () => {
  it('keeps every group within its budget', () => {
    const { by } = sizes();
    for (const [group, chars] of by) expect(chars, group).toBeLessThanOrEqual(BUDGET[group] ?? 0);
  });

  it('keeps what every agent carries small', () => {
    expect(sizes().core).toBeLessThanOrEqual(PLAIN_CORE);
  });

  it('has a budget for every group', () => {
    for (const g of [...TOOL_GROUPS.map((x) => x.id), 'core', 'memory', 'knowledge']) expect(BUDGET[g], g).toBeGreaterThan(0);
  });
});
