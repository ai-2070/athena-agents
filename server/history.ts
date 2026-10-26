// The history of skills, agents and teams: their kept versions as readable text, putting one back,
// and bringing back deleted ones. (Versions are kept by store.ts and skills.ts; see versions.ts.)
import { agents, workflows, log } from './store.ts';
import { getSkill, restoreSkill, skillVersionsDir } from './skills.ts';
import type { SkillVersionItem } from './skills.ts';
import { listVersions, getVersion, changedFields, deletedIn, withActor } from './versions.ts';
import type { Version } from './versions.ts';
import type { Agent, DeletedItem, Team, VersionDetail, VersionEntry, VersionHistory, VersionKind } from '../shared/types.ts';

type Item = Agent | Team | SkillVersionItem;
const notFound = (msg: string) => Object.assign(new Error(msg), { status: 404 });
export const VERSION_KINDS: VersionKind[] = ['skill', 'agent', 'team'];
export const isVersionKind = (k: unknown): k is VersionKind => VERSION_KINDS.includes(k as VersionKind);

// Each kind: where its versions are, what it is now, and the fields that don't count.
function kindOf(kind: VersionKind) {
  if (kind === 'agent') return { dir: (id = '') => agents.versionsDir(id)!, now: (id: string): Item | null => agents.get(id), ignore: agents.versionIgnore, label: 'agent' };
  if (kind === 'team') return { dir: (id = '') => workflows.versionsDir(id)!, now: (id: string): Item | null => workflows.get(id), ignore: workflows.versionIgnore, label: 'team' };
  return {
    dir: (id = '') => skillVersionsDir(id),
    now: (id: string): Item | null => {
      const s = getSkill(id);
      return s ? { slug: s.slug, name: s.name, description: s.description, body: s.body.trim() } : null;
    },
    ignore: ['files'] as readonly string[],
    label: 'skill',
  };
}
const okId = (id: string) => /^[\w.-]+$/.test(String(id)) && !id.startsWith('.');

// ---------- as text ----------
const FIELD_NAMES: Record<string, string> = {
  systemPrompt: 'instructions',
  body: 'instructions',
  toolGroups: 'tools',
  mcpServers: 'MCP servers',
  alwaysAllow: 'always allowed',
  claudeAuth: 'sign-in',
  hermesProfile: 'Hermes profile',
  knowledge: 'knowledge',
  steps: 'steps',
  lead: 'lead',
};
const fieldName = (kind: VersionKind, k: string) => (kind === 'team' && k === 'description' ? 'goal' : kind === 'skill' && k === 'description' ? 'when to use it' : FIELD_NAMES[k] || k);

const agentName = (id: string) => agents.get(id)?.name || `(deleted agent ${id})`;
const skillName = (slug: string) => getSkill(slug)?.name || slug;
const list = (xs: unknown) => (Array.isArray(xs) && xs.length ? xs.join(', ') : '-');

export function asText(kind: VersionKind, item: Item): string {
  if (kind === 'skill') {
    const s = item as SkillVersionItem;
    return [`Name: ${s.name}`, `When to use it: ${s.description}`, s.files?.length ? `Extra files: ${s.files.join(', ')}` : '', '', s.body.trim()].filter((x, i) => x || i === 3).join('\n');
  }
  if (kind === 'agent') {
    const a = item as Agent;
    return [
      `Name: ${a.emoji || ''} ${a.name}`.replace(/ +/g, ' '),
      `Specialty: ${a.specialty || '-'}`,
      a.description ? `Description: ${a.description}` : '',
      `Runs on: ${a.engine}${a.model ? ` (${a.model})` : ''}${a.engine === 'hermes' && a.hermesProfile ? `, profile ${a.hermesProfile}` : ''}`,
      `Autonomy: ${a.autonomy || 'ask'}`,
      `Tools: ${list(a.toolGroups)}`,
      `MCP servers: ${list(a.mcpServers)}`,
      `Skills: ${list((a.skills || []).map(skillName))}`,
      `Knowledge folders: ${list(a.knowledge?.folders)}`,
      `Workspace: ${a.workspace || '(default)'}`,
      `Always allowed: ${list(a.alwaysAllow)}`,
      '',
      'Instructions:',
      (a.systemPrompt || '').trim() || '(none)',
    ]
      .filter((x, i, all) => x || all[i + 1] === 'Instructions:')
      .join('\n');
  }
  const t = item as Team;
  const members = Array.isArray(t.members) ? t.members : [...new Set((t.steps || []).filter((x) => x.type === 'agent' && x.agentId).map((x) => x.agentId as string))];
  const other = (t.steps || []).filter((x) => x.type !== 'agent');
  return [
    `Name: ${t.name}`,
    `Goal: ${t.description || '-'}`,
    `Members: ${list(members.map((id) => `${agentName(id)}${t.lead === id ? ' (lead)' : ''}`))}`,
    `Tools: ${list(t.access?.toolGroups)}`,
    `MCP servers: ${list(t.access?.mcpServers)}`,
    `Skills: ${list((t.skills || []).map(skillName))}`,
    `Files: ${list(t.files)}`,
    t.schedule && t.schedule.type !== 'none' ? `Schedule: ${t.schedule.type} ${t.schedule.time || ''}${t.schedule.minutes ? `every ${t.schedule.minutes} min` : ''}${t.enabled === false ? ' (off)' : ''}`.trim() : '',
    other.length ? `Other steps: ${other.map((x) => x.label || x.type).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- history ----------
const entry = (kind: VersionKind, v: Version<Item>, newer: Item | null, ignore: readonly string[]): VersionEntry => ({
  id: v.id,
  at: v.at,
  by: v.by,
  ...(v.deleted ? { deleted: true } : {}),
  ...(v.note ? { note: v.note } : {}),
  changes: newer ? changedFields(v.item, newer, ignore).map((k) => fieldName(kind, k)) : v.deleted ? ['deleted'] : [],
});

export function historyOf(kind: VersionKind, id: string): VersionHistory {
  if (!okId(id)) throw notFound('Nothing by that id.');
  const k = kindOf(kind);
  const now = k.now(id);
  const versions = listVersions<Item>(k.dir(id));
  if (!now && !versions.length) throw notFound(`No ${k.label} by that id.`);
  // each version's changes: what the one after it (the next newer, or the current) is different in
  const entries = versions.map((v, i) => entry(kind, v, i === 0 ? (v.deleted ? null : now) : versions[i - 1].deleted ? null : versions[i - 1].item, k.ignore));
  return { kind, id, name: String((now || versions[0].item).name || id), current: now ? asText(kind, now) : null, versions: entries };
}

export function versionOf(kind: VersionKind, id: string, vid: string): VersionDetail {
  if (!okId(id)) throw notFound('Nothing by that id.');
  const k = kindOf(kind);
  const versions = listVersions<Item>(k.dir(id));
  const i = versions.findIndex((v) => v.id === vid);
  if (i === -1) throw notFound('That version is gone.');
  const v = versions[i];
  const newer = i === 0 ? (v.deleted ? null : k.now(id)) : versions[i - 1].deleted ? null : versions[i - 1].item;
  return { ...entry(kind, v, newer, k.ignore), name: String(v.item.name || id), text: asText(kind, v.item) };
}

/** Put a version back. The current one is kept as a version first, so this can be undone too. */
export function restoreVersion(kind: VersionKind, id: string, vid: string): { name: string } {
  if (!okId(id)) throw notFound('Nothing by that id.');
  const k = kindOf(kind);
  const v = getVersion<Item>(k.dir(id), vid);
  if (!v) throw notFound('That version is gone.');
  const when = new Date(v.at).toLocaleString();
  return withActor(
    'you',
    () => {
      if (kind === 'agent') {
        const now = agents.get(id);
        // what isn't part of a version stays as it is now
        const a = agents.save({ ...(v.item as Agent), id, pinned: now?.pinned ?? (v.item as Agent).pinned, lastModel: now?.lastModel, lastModelAt: now?.lastModelAt });
        log('agent', `${now ? 'Restored an earlier version of' : 'Brought back'} the agent ${a.name}`, { agentId: id });
        return { name: a.name };
      }
      if (kind === 'team') {
        const now = workflows.get(id);
        const t = workflows.save({ ...(v.item as Team), id, pos: now ? now.pos : (v.item as Team).pos, rot: now ? now.rot : (v.item as Team).rot, angle: now ? now.angle : (v.item as Team).angle });
        log('team', `${now ? 'Restored an earlier version of' : 'Brought back'} the team ${t.name}`);
        return { name: t.name };
      }
      const had = getSkill(id);
      const s = restoreSkill({ ...(v.item as SkillVersionItem), slug: id }, v.id);
      log('skill', `${had ? 'Restored an earlier version of' : 'Brought back'} the skill "${s?.name || id}"`);
      return { name: s?.name || id };
    },
    { force: true, note: `replaced by the version from ${when}` },
  );
}

/** What was deleted and can come back (in this project for agents and teams; every skill). */
export function deletedItems(kind: VersionKind): DeletedItem[] {
  const k = kindOf(kind);
  return deletedIn<Item>(k.dir(), (id) => k.now(id) !== null).map(({ id, version }) => ({ kind, id, name: String(version.item.name || id), at: version.at, by: version.by }));
}

/** Bring a deleted one back as it was when it was deleted. */
export function undelete(kind: VersionKind, id: string): { name: string } {
  const k = kindOf(kind);
  if (!okId(id)) throw notFound('Nothing by that id.');
  if (k.now(id)) throw Object.assign(new Error(`That ${k.label} isn't deleted.`), { status: 409 });
  const last = listVersions<Item>(k.dir(id))[0];
  if (!last?.deleted) throw notFound(`No deleted ${k.label} by that id.`);
  return restoreVersion(kind, id, last.id);
}
