// Skills: reusable instructions (Claude Code's SKILL.md format) you give to agents three ways:
// per agent, per team (every member while it works for the team) or per project (every agent).
// The Brain has skills too: it follows them in every turn (Self-improvement: it records workflows itself).
import { Plate } from '../ui/surface.tsx';
import { Button } from '../ui/button.tsx';
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { GET, POST, PUT, DEL, attempt, refreshSoon, confirmBox, state } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { logo } from '../icons.ts';
import { SkillMark } from '../skillmark.tsx';
import { skillPicker, loadSkills, forgetSkills } from '../skillpick.ts';
import { deletedButton } from '../history.tsx';
import { openEditor, openGitHub, openImport } from '../skilldialogs.tsx';
import { DomNode, Icon, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { SearchBox } from '../ui/controls.tsx';
import { buttonClass } from '../ui/classes.ts';
import type { Agent, AppState, ClaudeSkill, ServerEvent, SkillInstallResult, SkillListing, TeamListing } from '../../shared/types.ts';

interface SkillsData {
  skills: SkillListing[];
  claude: ClaudeSkill[];
}

// kept while you move around the app, as before
let lastQuery = '';

const brainList = (d: AppState): string[] => d.settings?.brainSkills || [];
/** Adds the skill to a list, or takes it out when it is there. */
export const flip = (list: readonly string[], slug: string, on: boolean): string[] => (on ? list.filter((x) => x !== slug) : [...new Set([...list, slug])]);

// (the saved list goes into the page's state right away, so a menu drawn next shows it)
const saveBrain = (skills: string[]) =>
  attempt(() => PUT<{ skills: string[] }>('/brain/skills', { skills })).then((r) => {
    if (r && state.data) state.data.settings.brainSkills = r.skills;
    refreshSoon(0);
  });
const saveProject = (id: string, skills: string[]) => attempt(() => rpc.projects.change({ id, skills })).then(() => refreshSoon(0));
const saveAgent = (a: Agent, skills: string[]) => attempt(() => rpc.agents.change({ id: a.id, skills })).then(() => refreshSoon(0));

function SkillsPage({ open }: { open?: string }) {
  const d = useAppState();
  const [data, setData] = useState<SkillsData | null>(null);
  const [teams, setTeams] = useState<TeamListing[]>([]);
  const [query, setQuery] = useState(lastQuery);
  const loadTeams = useCallback(() => rpc.workflows.list().then(setTeams).catch(() => {}), []);
  const reload = useCallback(async () => {
    const [s, t] = await Promise.all([GET<SkillsData>('/skills'), rpc.workflows.list().catch((): TeamListing[] => [])]);
    forgetSkills();
    await loadSkills(true);
    setData(s);
    setTeams(t);
    return s;
  }, []);
  useEffect(() => {
    // #/skills/<slug> opens that skill (the Brain chat links here when it changed one)
    void reload().then((s) => open && s.skills.some((x) => x.slug === open) && void openEditor(open, reload));
  }, [reload, open]);
  useServerEvents((ev: ServerEvent) => {
    // the Brain made or changed a skill: show it
    if (ev.type === 'activity' && (ev as ServerEvent & { entry?: { kind?: string } }).entry?.kind === 'skill') void reload();
    if (['agents', 'workflows', 'project'].includes(ev.type)) void loadTeams();
  });
  if (!data || !d) return <p className="text-dim">Loading skills…</p>;

  const q = query.toLowerCase();
  const shown = data.skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
  const toImport = data.claude.filter((c) => !c.inLibrary);
  const proj = d.project;
  const brain = brainList(d);
  const newSkill = () => void openEditor(null, reload);
  const importButton = (label: string) => (
    <Button variant="ghost" onClick={() => openImport(data.claude, reload)}>
      <Icon name="download" size={14} />
      {label}
    </Button>
  );
  return (
    <>
      <p className="lede max-w-[68ch]">Skills are instructions for a kind of work: how you want an email written, your brand voice, a video edit checklist, a research method. Give them to one agent, to a team, or to the whole project. Agents open a skill when the task matches it.</p>
      <div className="flex flex-col gap-6 [&>.panel]:mt-0 [&>.panel>:last-child]:mb-0">
      <Plate className="panel">
        <div className="panel-head">
          <h2 className="flex items-center gap-2.5"><Icon name="folder-open" className="text-faint" />{` Project skills · ${proj?.name || ''}`}</h2>
          <span className="hint">every agent in this project gets these</span>
        </div>
        <DomNode make={() => skillPicker(proj?.skills || [], (s) => saveProject(proj.id, s), { empty: 'None yet. Add skills every agent here should follow, like your brand voice or how files are named.' })} deps={[proj?.id, (proj?.skills || []).join('|')]} />
      </Plate>
      <Plate className="panel">
        <div className="panel-head">
          <h2 className="flex items-center gap-2.5"><Icon name="brain" className="text-faint" /> The Brain's skills</h2>
          <span className="hint">in every project</span>
        </div>
        <DomNode make={() => skillPicker(brain, saveBrain, { empty: 'None. The Brain still makes and edits skills when you ask it to.' })} deps={[brain.join('|')]} />
        <p className="hint mt-4 max-w-[68ch]">
          {brain.includes('self-improvement')
            ? 'With Self-improvement the Brain keeps your skills up to date by itself: after an agent finishes a sizeable job, it records the workflow as a skill or improves one, and says so in the Brain chat. Take the skill away to stop that.'
            : 'Give the Brain Self-improvement and it records workflows as skills by itself after agents finish sizeable jobs. You can also ask it in the Brain chat: "save how we did that as a skill".'}
        </p>
      </Plate>
      </div>
      <h2 className="section mt-10 mb-4">{`Library (${data.skills.length})`}</h2>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SearchBox className="w-[min(360px,100%)]" placeholder="Search skills" label="Search skills" value={query} onChange={(v) => setQuery((lastQuery = v))} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <DomNode as="span" make={() => deletedButton(['skill'], () => void reload())} deps={[]} />
          <Button variant="ghost" onClick={() => openGitHub(reload)}>
            <DomNode as="span" className="inline-flex" make={() => logo('github', 14)} deps={[]} />
            From GitHub
          </Button>
          {toImport.length ? importButton(`Import from Claude Code (${toImport.length})`) : null}
          <Button  onClick={newSkill}>
            <Icon name="plus" size={14} />
            New skill
          </Button>
        </div>
      </div>
      {shown.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((s) => (
            <SkillCard key={s.slug} s={s} d={d} teams={teams} reload={reload} loadTeams={loadTeams} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="m-0 text-dim">{data.skills.length ? 'No skill matches.' : 'No skills yet.'}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button  onClick={newSkill}>
              <Icon name="plus" size={14} />
              Write your first skill
            </Button>
            {toImport.length ? importButton('Import from Claude Code') : null}
          </div>
        </div>
      )}
    </>
  );
}

/** Who has a skill: the Brain, the project, teams, agents. */
function usedBy(slug: string, d: AppState, teams: TeamListing[]) {
  return {
    brain: brainList(d).includes(slug),
    project: (d.project?.skills || []).includes(slug),
    teams: teams.filter((t) => (t.skills || []).includes(slug)),
    agents: d.agents.filter((a) => (a.skills || []).includes(slug)),
  };
}

// who has the skill, under its card (skill-use marks them for the tests)
const USE = 'skill-use pill-shadow inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full border text-[12px]';
const USE_AGENT = `${USE} border-line text-dim`;
const USE_PROJ = `${USE} text-accent border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-line))]`;
const USE_TEAM = `${USE} text-ink border-[color-mix(in_srgb,var(--c)_45%,var(--color-line))] bg-[color-mix(in_srgb,var(--c)_10%,transparent)]`;

function SkillCard({ s, d, teams, reload, loadTeams }: { s: SkillListing; d: AppState; teams: TeamListing[]; reload: () => Promise<unknown>; loadTeams: () => Promise<unknown> }) {
  const u = usedBy(s.slug, d, teams);
  const [updating, setUpdating] = useState(false);
  const update = async () => {
    setUpdating(true);
    const r = await attempt(() => POST<SkillInstallResult>('/skills/install', { url: s.origin!.url }), (x) => (x.installed.length ? `Updated ${x.installed.map((i) => i.name).join(', ')}` : 'Nothing updated'));
    setUpdating(false);
    if (r) await reload();
  };
  const remove = async () => {
    if (!(await confirmBox(`Delete the skill "${s.name}"? It is taken off every agent, team and project that has it.`, { ok: 'Delete', danger: true }))) return;
    if (await attempt(() => DEL(`/skills/${s.slug}`), 'Deleted')) await reload();
  };
  const uses = [
    u.brain ? <span key="brain" className={USE_PROJ}><Icon name="brain" size={11} />The Brain</span> : null,
    u.project ? <span key="project" className={USE_PROJ}><Icon name="folder-open" size={11} />Project</span> : null,
    ...u.teams.map((t) => (
      <span key={t.id} className={USE_TEAM} style={{ '--c': t.color || 'var(--color-accent)' } as CSSProperties}>
        <Icon name="users" size={11} />
        {t.name}
      </span>
    )),
    ...u.agents.map((a) => <span key={a.id} className={USE_AGENT}>{`${a.emoji || ''} ${a.name}`}</span>),
  ].filter(Boolean);
  return (
    <Plate className="skill-card card hover:shadow-none gap-3">
      <div className="flex items-center gap-3">
        {/* the app it is for, or what it works with; a skill of your own is the puzzle piece */}
        <SkillMark slug={s.slug} />
        <div className="flex-1 min-w-0">
          <div className="skill-name font-semibold text-[15px]">{s.name}</div>
          <div className="hint">
            {s.files.length ? `${s.files.length} extra file${s.files.length === 1 ? '' : 's'}` : 'instructions only'}
            {s.origin ? (
              <span>
                {' · from '}
                <a href={s.origin.url} target="_blank" rel="noopener">{s.origin.repo}</a>
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="m-0 text-dim text-[13px] leading-[1.45] line-clamp-3">{s.description}</p>
      <div className="skill-uses flex flex-wrap gap-1.5">{uses.length ? uses : <span className="hint">Not given to anyone yet</span>}</div>
      <div className="skill-foot mt-auto flex items-center gap-2 border-t border-line pt-4">
        <GiveTo s={s} d={d} teams={teams} loadTeams={loadTeams} />
        <Button variant="ghost" size="small" onClick={() => void openEditor(s.slug, reload)}>
          <Icon name="pencil" size={13} />
          Edit
        </Button>
        {s.origin ? (
          <Button variant="ghost" size="small" disabled={updating} title={`Download it again from ${s.origin.repo} (the current version is kept in History)`} onClick={() => void update()}>
            <Icon name="rotate-cw" size={13} />
            Update
          </Button>
        ) : null}
        <span className="flex-1 min-w-0" />
        <Button variant="danger" size="small" title="Delete the skill" aria-label={`Delete the skill ${s.name}`} onClick={() => void remove()}>
          <Icon name="trash-2" size={13} />
        </Button>
      </div>
    </Plate>
  );
}

/** "Give to…": the Brain, the project, a team or an agent. Ticks show who has it; tick again to take it away. */
function GiveTo({ s, d, teams, loadTeams }: { s: SkillListing; d: AppState; teams: TeamListing[]; loadTeams: () => Promise<unknown> }) {
  const u = usedBy(s.slug, d, teams);
  const item = (key: string, on: boolean, label: string, lead: ReactNode, save: () => Promise<unknown>) => (
    <Menu.CheckboxItem key={key} className={(st) => `st-menu-item${st.checked ? ' on' : ''}`} checked={on} onCheckedChange={() => void save()}>
      {on ? <Icon name="check" size={14} /> : lead}
      <span className="flex-1 min-w-0">{label}</span>
    </Menu.CheckboxItem>
  );
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonClass(undefined, 'small')}>
        <Icon name="plus" size={13} />
        Give to…
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-96 outline-none" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Popup className="st-menu dd skp-menu static w-75 max-w-75">
            <Menu.Group>
              <Menu.GroupLabel className="st-menu-head">{`Give "${s.name}" to`}</Menu.GroupLabel>
              {item('brain', u.brain, 'The Brain', <Icon name="brain" size={14} />, () => saveBrain(flip(brainList(d), s.slug, u.brain)))}
              {item('project', u.project, `This project (${d.project?.name || ''})`, <Icon name="folder-open" size={14} />, () => saveProject(d.project.id, flip(d.project?.skills || [], s.slug, u.project)))}
            </Menu.Group>
            {teams.length ? (
              <Menu.Group>
                <Menu.GroupLabel className="st-menu-head">A team</Menu.GroupLabel>
                {teams.map((t) => {
                  const on = u.teams.some((x) => x.id === t.id);
                  return item(t.id, on, t.name, <Icon name="users" size={14} />, () => attempt(() => rpc.workflows.change({ id: t.id, skills: flip(t.skills || [], s.slug, on) })).then(loadTeams));
                })}
              </Menu.Group>
            ) : null}
            {d.agents.length ? (
              <Menu.Group>
                <Menu.GroupLabel className="st-menu-head">An agent</Menu.GroupLabel>
                <div className="model-list max-h-70">
                  {d.agents.map((a) => {
                    const on = u.agents.some((x) => x.id === a.id);
                    return item(a.id, on, a.name, <span className="w-3.5 text-center">{a.emoji || '🤖'}</span>, () => saveAgent(a, flip(a.skills || [], s.slug, on)));
                  })}
                </div>
              </Menu.Group>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export const title = () => 'Skills';
export const { render, unmount } = reactPage((params) => <SkillsPage open={params[0]} />);
