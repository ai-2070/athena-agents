// Presets: save an agent or a whole team (with its agents) as a reusable template, kept in
// data/presets and available in every project. Clone: copy an agent or a team in this project.
import path from 'node:path';
import { agents, workflows, log } from './store.js';
import { dataPath, ensureDir, readJSON, writeJSON, listFiles, uid } from './util.js';
import { newAgent } from './library.js';
import fs from 'node:fs';

const DIR = () => ensureDir(dataPath('presets'));
const RUNTIME_FIELDS = ['id', 'createdAt', 'updatedAt', 'lastModel', 'lastModelAt', 'pinned', 'workspace'];
const agentTemplate = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => !RUNTIME_FIELDS.includes(k) && !k.startsWith('_')));
const TEAM_FIELDS = ['name', 'description', 'color', 'access', 'skills', 'schedule'];
const teamTemplate = (t) => Object.fromEntries(TEAM_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, structuredClone(t[k])]));

export function listPresets() {
  return listFiles(DIR(), (n) => n.endsWith('.json'))
    .map((n) => readJSON(path.join(DIR(), n)))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      description: p.description || '',
      emoji: p.kind === 'agent' ? p.agent?.emoji || '🤖' : null,
      color: p.kind === 'team' ? p.team?.color || null : p.agent?.color || null,
      members: p.kind === 'team' ? p.members.map((m) => ({ name: m.name, emoji: m.emoji })) : null,
      lead: p.kind === 'team' && p.leadIndex >= 0 ? p.members[p.leadIndex]?.name : null,
      skills: p.kind === 'team' ? p.team?.skills || [] : p.agent?.skills || [],
      savedAt: p.savedAt,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function saveAgentPreset(agentId, { name } = {}) {
  const a = agents.get(agentId);
  if (!a) throw new Error('No such agent.');
  const p = { id: uid('pa'), kind: 'agent', name: String(name || a.name).slice(0, 80), description: a.specialty || '', savedAt: Date.now(), agent: agentTemplate(a) };
  writeJSON(path.join(DIR(), `${p.id}.json`), p);
  log('preset', `Saved ${a.name} as a preset`);
  return p;
}

export function saveTeamPreset(teamId, { name } = {}) {
  const t = workflows.get(teamId);
  if (!t) throw new Error('No such team.');
  const ids = (t.members || []).filter((id) => agents.get(id));
  const p = {
    id: uid('pt'),
    kind: 'team',
    name: String(name || t.name).slice(0, 80),
    description: t.description || '',
    savedAt: Date.now(),
    team: teamTemplate(t),
    members: ids.map((id) => agentTemplate(agents.get(id))),
    leadIndex: ids.indexOf(t.lead),
  };
  writeJSON(path.join(DIR(), `${p.id}.json`), p);
  log('preset', `Saved the team ${t.name} (${ids.length} agents) as a preset`);
  return p;
}

export function deletePreset(id) {
  if (!/^p[at][\w-]+$/.test(String(id))) throw new Error('No such preset.');
  fs.rmSync(path.join(DIR(), `${id}.json`), { force: true });
}

// Make it in the current project: a new agent, or a new team with new agents.
export function usePreset(id) {
  const p = readJSON(path.join(DIR(), `${path.basename(String(id))}.json`), null);
  if (!p) throw new Error('No such preset.');
  if (p.kind === 'agent') {
    const a = newAgent({ ...structuredClone(p.agent), source: { type: 'preset', preset: p.id } });
    log('preset', `Created ${a.name} from a preset`, { agentId: a.id });
    return { agent: a };
  }
  const made = p.members.map((m) => newAgent({ ...structuredClone(m), source: { type: 'preset', preset: p.id } }));
  const team = workflows.save({
    ...teamTemplate(p.team),
    members: made.map((a) => a.id),
    steps: made.map((a) => ({ type: 'agent', agentId: a.id })),
    lead: p.leadIndex >= 0 ? made[p.leadIndex]?.id || null : null,
    schedule: p.team.schedule || { type: 'none' },
    enabled: false,
  });
  log('preset', `Created the team ${team.name} from a preset (${made.length} agents)`);
  return { team, agents: made };
}

// Copy a team in this project. withAgents: its members are copied too (otherwise the copy shares them).
export function cloneTeam(teamId, { withAgents = false } = {}) {
  const t = workflows.get(teamId);
  if (!t) throw new Error('No such team.');
  let members = (t.members || []).filter((id) => agents.get(id));
  let lead = t.lead;
  if (withAgents) {
    const map = new Map(members.map((id) => [id, newAgent({ ...agentTemplate(agents.get(id)), name: `${agents.get(id).name} (copy)` })]));
    members = members.map((id) => map.get(id).id);
    lead = t.lead ? map.get(t.lead)?.id || null : null;
  }
  const copy = workflows.save({
    ...teamTemplate(t),
    name: `${t.name} (copy)`,
    members,
    steps: members.map((id) => ({ type: 'agent', agentId: id })),
    lead,
    schedule: { type: 'none' },
    enabled: false,
  });
  log('team', `Cloned the team ${t.name}${withAgents ? ' with copies of its agents' : ''}`);
  return copy;
}
