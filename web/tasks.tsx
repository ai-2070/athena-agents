// The same task list in agent, team and Brain chats. Editing stays inline with the work.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { confirmBox, onEvent, onReconnect, state } from './core.ts';
import { projectAt } from './client/connection.ts';
import { rpcAt } from './client/rpc.ts';
import { useProjectAgents } from './projectagents.ts';
import { CollapseRoot, CollapsePanel } from './ui/collapse.tsx';
import { Icon, useAppState } from './ui/react.tsx';
import { Button, IconButton } from './ui/button.tsx';
import { Pill } from './ui/marks.tsx';
import { SelectControl } from './ui/select.tsx';
import type { TaskPage, TaskScope, TaskStatus, TaskSummary, Team, WorkTask } from '../shared/types.ts';

const STATUS = [{ value: 'pending', label: 'Pending', icon: 'clock' }, { value: 'in_progress', label: 'In progress', icon: 'play' }, { value: 'completed', label: 'Completed', icon: 'circle-check' }];
const sameScope = (a: TaskScope, b: TaskScope) => a.kind === b.kind && a.id === b.id;
const scopeValue = (s: TaskScope) => s.kind === 'brain' ? 'brain' : `${s.kind}:${s.id}`;
const scopeFrom = (value: string): TaskScope => value === 'brain' || value === 'all' ? { kind: 'brain' } : { kind: value.startsWith('team:') ? 'team' : 'agent', id: value.slice(value.indexOf(':') + 1) };

/** foreign: the chat's project, when it isn't the open one (an Overview pane): the tasks are that project's. */
/** What the Tasks row shows beside its button (the chat's earlier chats, web/chatlist.tsx), and its open state when
 *  something outside opens and closes it (only one of the two panels is open at a time). */
export interface TaskPanelShare {
  beside?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TaskPanel({ view = 'all', scope = { kind: 'brain' }, filters = false, chatId, projectId: foreign, share }: { view?: string; scope?: TaskScope; filters?: boolean; chatId?: string; projectId?: string; share?: TaskPanelShare }) {
  const open = useAppState()?.project?.id || '';
  const projectId = foreign || open;
  return <TaskList key={`${projectId}/${view}/${chatId || ''}`} view={view} scope={scope} filters={filters} chatId={chatId} projectId={projectId} at={projectAt(foreign)} share={share} />;
}

function TaskList({ view, scope, filters, chatId, projectId, at, share }: { view: string; scope: TaskScope; filters: boolean; chatId?: string; projectId: string; at: string; share?: TaskPanelShare }) {
  const app = useAppState();
  const theirs = useProjectAgents(at ? projectId : undefined);
  const panelId = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = share?.open ?? ownOpen;
  const setOpen = (o: boolean) => (share?.onOpenChange ? share.onOpenChange(o) : setOwnOpen(o));
  const [target, setTarget] = useState(view);
  const [status, setStatus] = useState<'open' | 'all' | TaskStatus>('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<TaskPage | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const [editing, setEditing] = useState<WorkTask | 'new' | null>(null);
  const serial = useRef(0);
  const editSerial = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; serial.current++; editSerial.current++; }; }, []);
  // (another project's list stays its own; the open project's is left once another opens)
  const here = () => live.current && (!!at || (state.data?.project?.id || '') === projectId);
  const load = useCallback(async (more = false) => {
    const request = ++serial.current;
    setLoading(true); setError('');
    try {
      const [next, unfinished] = await Promise.all([rpcAt(at).tasks.list({ view: target, status, search, limit: 100, offset: more ? page?.nextOffset || 0 : 0 }), rpcAt(at).tasks.list({ view: target, status: 'open', limit: 1 })]);
      if (request !== serial.current || !here()) return;
      setOpenCount(unfinished.total);
      setPage((old) => more && old ? { ...next, tasks: [...old.tasks, ...next.tasks] } : next);
    } catch (e) { if (request === serial.current && here()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === serial.current && here()) setLoading(false); }
  }, [target, status, search, projectId, page?.nextOffset]);
  const reload = useRef(load); reload.current = load;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void reload.current(), 120);
    return () => clearTimeout(timer);
  }, [open, target, status, search]);
  useEffect(() => {
    if (!open) return;
    void rpcAt(at).workflows.list().then((all) => { if (here()) setTeams(all); }).catch((e: unknown) => { if (here()) setError(e instanceof Error ? e.message : String(e)); });
    const update = onEvent((e) => { if (e.type === 'tasks' && (!e.projectId || e.projectId === projectId)) void reload.current(); });
    const reconnect = onReconnect(() => void reload.current());
    return () => { update(); reconnect(); };
  }, [open, projectId]);
  const agents = at ? theirs : app?.agents || [];
  const lists = [{ value: 'brain', label: 'The Brain', icon: 'brain' }, ...teams.map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}`, icon: 'users' })), ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, icon: 'bot' }))];
  const nameOf = (value: string) => value === '' ? 'Unassigned' : lists.find((x) => x.value === value)?.label || 'Former owner';
  const edit = async (id: string) => {
    const request = ++editSerial.current;
    setError('');
    try { const result = await rpcAt(at).tasks.get({ id }); if (here() && request === editSerial.current) setEditing(result.task); }
    catch (e) { if (here()) setError(e instanceof Error ? e.message : String(e)); }
  };
  const clearTasks = async () => {
    if (clearing || loading || !openCount) return;
    const list = target === 'all' ? 'this project' : nameOf(target);
    if (!(await confirmBox(`Clear all open tasks in ${list}? Completed tasks will stay. Dependency links to removed tasks will also be removed.`, { ok: 'Clear tasks', danger: true })) || !here()) return;
    setClearing(true); setError('');
    let failure = '';
    try {
      const tasks: TaskSummary[] = [];
      let offset: number | null = 0;
      while (offset != null) {
        const result: TaskPage = await rpcAt(at).tasks.list({ view: target, status: 'open', limit: 100, offset });
        if (!here()) return;
        tasks.push(...result.tasks); offset = result.nextOffset;
      }
      for (const task of tasks) {
        const current = await rpcAt(at).tasks.get({ id: task.id });
        if (!here()) return;
        if (current.task.status !== 'pending' && current.task.status !== 'in_progress') continue;
        await rpcAt(at).tasks.change({ id: task.id, status: 'deleted', expectedUpdatedAt: current.task.updatedAt });
        if (!here()) return;
      }
      setEditing(null);
    } catch (e) { failure = e instanceof Error ? e.message : String(e); }
    finally { if (here()) { setClearing(false); await reload.current(); if (here() && failure) setError(failure); } }
  };
  return <CollapseRoot open={open} onOpenChange={setOpen} render={<section />} className="task-panel shrink-0 min-w-0 px-1 text-[13px]" aria-label="Tasks">
    <div className="flex flex-wrap items-center gap-2 pt-1 pb-2">
      <Button variant="plain" size="tiny" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        <Icon name="list-checks" size={15} />Tasks<Icon name="chevron-down" size={12} className={`transition-transform duration-200 ease-in-out ${open ? '' : '-rotate-90'}`} />
      </Button>
      {share?.beside}
      {open && <><span className="min-w-0 flex-1 text-dim" aria-live="polite">{page ? `${page.total} ${status === 'open' ? 'open' : 'tasks'}` : ''}</span><Button variant="ghost" size="tiny" disabled={clearing || loading || !page || !openCount} onClick={() => void clearTasks()}><Icon name="trash-2" size={14} />{clearing ? 'Clearing…' : 'Clear tasks'}</Button><Button variant="ghost" size="tiny" disabled={clearing} onClick={() => setEditing('new')}><Icon name="plus" size={14} />Add task</Button></>}
    </div>
    <CollapsePanel id={panelId}><div className="max-h-[min(55vh,420px)] overflow-y-auto border-y border-line pt-2 pb-1">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {filters && <SelectControl aria-label="Task list" value={target} options={[{ value: 'all', label: 'All project tasks', icon: 'list-checks' }, ...lists]} onChange={(v) => { setTarget(v); setPage(null); setEditing(null); }} className="max-w-full flex-1" />}
        <SelectControl aria-label="Filter task status" value={status} options={[{ value: 'open', label: 'Open', icon: 'folder-open' }, { value: 'all', label: 'All statuses', icon: 'list-checks' }, ...STATUS]} onChange={(v) => { setStatus(v as 'open' | 'all' | TaskStatus); setPage(null); }} />
        <div className="relative min-w-24 flex-1"><Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" /><input type="search" className="w-full pl-9" aria-label="Search tasks" placeholder="Search tasks…" value={search} maxLength={240} onChange={(e) => { setSearch(e.target.value); setPage(null); }} /></div>
      </div>
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-red"><span className="min-w-0 flex-1 wrap-anywhere">{error}</span><Button variant="plain" size="tiny" onClick={() => void load()}>Retry</Button></div>}
      {editing && <TaskEditor key={editing === 'new' ? 'new' : `${editing.id}/${editing.updatedAt}`} task={editing === 'new' ? null : editing} scope={filters ? scopeFrom(target) : scope} lists={lists} teams={teams} candidates={page?.tasks || []} chatId={chatId} projectId={projectId} at={at} allowScopeChange={filters} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} onReload={() => editing !== 'new' && void edit(editing.id)} />}
      {!page && loading ? <p role="status" className="m-0 py-4 text-dim">Loading tasks…</p> : page?.tasks.length ? <ul className="m-0 list-none divide-y divide-line p-0">
        {page.tasks.map((t) => <li key={t.id} className="py-2.5">
          <div className="flex items-start gap-2">
            <Button variant="plain" size="tiny" className="min-w-0 flex-1 justify-start whitespace-normal text-left" onClick={() => void edit(t.id)}><span className="min-w-0 wrap-anywhere">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}</span></Button>
            <Pill tone={t.status === 'completed' ? 'ok' : t.blockedBy.length ? 'warn' : t.status === 'in_progress' ? 'info' : 'dim'}>{t.blockedBy.length ? 'Blocked' : STATUS.find((s) => s.value === t.status)?.label || t.status}</Pill>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[12px] text-dim"><span>{nameOf(t.owner)}</span>{filters && t.owner !== scopeValue(t.scope) && <span>List: {nameOf(scopeValue(t.scope))}</span>}{t.blockedBy.length > 0 && <span>Waiting for {t.blockedBy.length} prerequisite{t.blockedBy.length === 1 ? '' : 's'}</span>}</div>
        </li>)}
      </ul> : !loading && !error && <p className="m-0 py-1 text-dim">{search || status !== 'open' ? 'No tasks match these filters.' : 'No open tasks. Add one here, or ask for a plan in the chat.'}</p>}
      {page?.nextOffset != null && <Button variant="plain" size="small" disabled={loading} onClick={() => void load(true)}>{loading ? 'Loading…' : 'Show more tasks'}</Button>}
    </div></CollapsePanel>
  </CollapseRoot>;
}

function TaskEditor({ task, scope: initialScope, lists, teams, candidates, chatId, projectId, at, allowScopeChange, onClose, onSaved, onReload }: { task: WorkTask | null; scope: TaskScope; lists: { value: string; label: string }[]; teams: Team[]; candidates: TaskSummary[]; chatId?: string; projectId: string; at: string; allowScopeChange: boolean; onClose: () => void; onSaved: () => void; onReload: () => void }) {
  const [scope, setScope] = useState(task?.scope || initialScope);
  const [subject, setSubject] = useState(task?.subject || '');
  const [description, setDescription] = useState(task?.description || '');
  const [activeForm, setActiveForm] = useState(task?.activeForm || '');
  const [owner, setOwner] = useState(task?.owner || (initialScope.kind === 'agent' ? `agent:${initialScope.id}` : ''));
  const [status, setStatus] = useState<TaskStatus>(task?.status || 'pending');
  const [dependencies, setDependencies] = useState(task?.blockedBy || []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = () => !!at || (state.data?.project?.id || '') === projectId;
  const owners = lists.filter((x) => x.value === 'brain' || scope.kind === 'brain' || (scope.kind === 'agent' ? x.value === `agent:${scope.id}` : x.value === `team:${scope.id}` || teams.find((t) => t.id === scope.id)?.members.includes(x.value.slice(6))));
  const save = async (deleted = false) => {
    if (!current() || busy) return;
    if (deleted && !(await confirmBox(`Remove the task “${task?.subject}”? Its dependency links will also be removed.`, { ok: 'Remove', danger: true }))) return;
    setBusy(true); setError('');
    try {
      if (task) await rpcAt(at).tasks.change({ id: task.id, subject, description, activeForm, owner, status: deleted ? 'deleted' : status, expectedUpdatedAt: task.updatedAt, addBlockedBy: dependencies.filter((id) => !task.blockedBy.includes(id)), removeBlockedBy: task.blockedBy.filter((id) => !dependencies.includes(id)) });
      else await rpcAt(at).tasks.create({ subject, description, activeForm, owner, scope, ...(chatId ? { chatId } : {}) });
      if (current()) onSaved();
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current()) setBusy(false); }
  };
  return <form className="task-editor mb-2 space-y-3 border-y border-line pt-3 pb-5" aria-label={task ? 'Edit task' : 'New task'} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <fieldset disabled={busy} className="min-w-0 space-y-3 border-0 p-0">
    <div className="flex items-center gap-2"><b className="min-w-0 flex-1">{task ? 'Edit task' : 'New task'}</b><IconButton type="button" variant="plain" aria-label="Close task editor" onClick={onClose}><Icon name="x" size={14} /></IconButton></div>
    <label className="field">Title<input autoFocus required maxLength={240} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
    <label className="field">Description<textarea required rows={3} maxLength={8000} placeholder="What needs to be done, and how to check it" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
    {!task && allowScopeChange && <label className="field">List<SelectControl aria-label="New task list" options={lists} value={scopeValue(scope)} onChange={(v) => { const s = scopeFrom(v); setScope(s); setOwner(s.kind === 'agent' ? `agent:${s.id}` : ''); }} /></label>}
    <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"><label className="field">Owner<SelectControl aria-label="Task owner" value={owner} options={[{ value: '', label: 'Unassigned' }, ...owners]} onChange={setOwner} /></label>{task && <label className="field">Status<SelectControl aria-label="Task status" options={STATUS} value={status} onChange={(v) => setStatus(v as TaskStatus)} /></label>}</div>
    <label className="field">Working label <span className="text-dim">(optional)</span><input maxLength={240} placeholder="Writing the report" value={activeForm} onChange={(e) => setActiveForm(e.target.value)} /></label>
    {task && <div className="space-y-2"><span>Prerequisites</span><div className="flex flex-wrap gap-2">{dependencies.map((id) => <Button type="button" key={id} variant="ghost" size="tiny" aria-label={`Remove prerequisite ${candidates.find((t) => t.id === id)?.subject || id}`} onClick={() => setDependencies(dependencies.filter((x) => x !== id))}>{candidates.find((t) => t.id === id)?.subject || id}<Icon name="x" size={12} /></Button>)}</div><SelectControl aria-label="Add prerequisite" value="" options={[{ value: '', label: 'Add a prerequisite…' }, ...candidates.filter((t) => t.id !== task.id && sameScope(t.scope, task.scope) && !dependencies.includes(t.id)).map((t) => ({ value: t.id, label: t.subject }))]} onChange={(id) => id && setDependencies([...dependencies, id])} />{task.blocks.length > 0 && <p className="m-0 text-[12px] text-dim">Blocks: {task.blocks.map((id) => candidates.find((t) => t.id === id)?.subject || id).join(', ')}</p>}</div>}
    {error && <div role="alert" className="text-red"><p className="m-0 wrap-anywhere">{error}</p>{task && <Button type="button" variant="plain" size="tiny" onClick={onReload}>Reload saved task</Button>}</div>}
    <div className="flex items-center gap-2"><Button type="submit" size="small" disabled={busy || !subject.trim() || !description.trim()}>{busy ? 'Saving…' : task ? 'Save task' : 'Create task'}</Button><Button type="button" variant="plain" size="small" disabled={busy} onClick={onClose}>Cancel</Button>{task && <Button type="button" variant="danger" size="small" className="ml-auto" disabled={busy} onClick={() => void save(true)}>Remove</Button>}</div>
    </fieldset>
  </form>;
}
