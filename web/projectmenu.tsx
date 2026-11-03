import { Menu } from '@base-ui/react/menu';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Project } from '../shared/types.ts';
import { attempt, POST, PUT, refreshSoon } from './core.ts';
import { projectMark } from './projectlogo.ts';
import { moveId } from './projectnav.ts';
import { Dropdown, DropdownItem, DropdownSeparator } from './ui/dropdown.tsx';
import { Icon } from './ui/react.tsx';

const ROW = "group relative flex items-center [&.dragging]:opacity-40 [&.drop-above]:before:absolute [&.drop-above]:before:-top-px [&.drop-above]:before:right-2.5 [&.drop-above]:before:left-2.5 [&.drop-above]:before:h-0.5 [&.drop-above]:before:rounded-[1px] [&.drop-above]:before:bg-accent [&.drop-below]:after:absolute [&.drop-below]:after:right-2.5 [&.drop-below]:after:-bottom-px [&.drop-below]:after:left-2.5 [&.drop-below]:after:h-0.5 [&.drop-below]:after:rounded-[1px] [&.drop-below]:after:bg-accent";
const RENAME_BTN = 'mr-1 grid h-6.5 w-6.5 flex-none cursor-pointer place-items-center rounded-[6px] border-0 bg-transparent p-0 text-faint opacity-0 [transition:opacity_0.15s] group-hover:opacity-100 hover:bg-panel-2 hover:text-accent focus-visible:opacity-100';

interface Props {
  anchor: Element;
  projects: Project[];
  active: Project;
  actions: { label: string; icon: string; run: () => unknown; danger?: boolean; separator?: boolean }[];
}

/** Mount against an existing plain-DOM trigger. Base UI owns dismissal and exit motion. */
export function mountProjectMenu(props: Props): () => void {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    root.render(<ProjectMenu {...props} open={false} close={close} dispose={dispose} />);
  };
  const dispose = () => {
    if (!open) setTimeout(() => { root.unmount(); host.remove(); }, 0);
  };
  flushSync(() => root.render(<ProjectMenu {...props} open close={close} dispose={dispose} />));
  return close;
}

function Mark({ project }: { project: Project }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) element.replaceChildren(projectMark(project, 16));
  }, [project]);
  return <span ref={ref} className="contents" />;
}

function ProjectMenu({ anchor, projects, active, actions, open, close, dispose }: Props & { open: boolean; close: () => void; dispose: () => void }) {
  const [ordered, setOrdered] = useState(projects);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [marks, setMarks] = useState<{ id: string; below: boolean } | null>(null);
  const [dragging, setDragging] = useState('');
  const dragId = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const returnFocusOnEscape = useRef(false);
  const items = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => { if (renaming) { input.current?.focus(); input.current?.select(); } }, [renaming]);
  const startRename = (p: Project) => { setName(p.name); setRenaming(p.id); };
  const finishRename = (p: Project, commit: boolean) => {
    if (renaming !== p.id) return;
    setRenaming(null);
    const next = name.trim();
    if (commit && next && next !== p.name) {
      p.name = next;
      setOrdered((current) => [...current]);
      void attempt(() => PUT(`/projects/${encodeURIComponent(p.id)}`, { name: next }), `Renamed to ${next}`).then(() => refreshSoon(0));
    }
  };
  const save = (ids: string[]) => {
    const byId = new Map(ordered.map((p) => [p.id, p]));
    setOrdered(ids.map((id) => byId.get(id)!));
    void attempt(() => POST('/projects/order', { ids })).then(() => refreshSoon(0));
  };
  const focusItem = (id: string) => setTimeout(() => items.current.get(id)?.focus(), 0);
  return (
    <Dropdown open={open} onOpenChange={(next, details) => {
      if (!next) {
        returnFocusOnEscape.current = details.reason === 'escape-key';
        close();
      }
    }} onOpenChangeComplete={(next) => { if (!next) dispose(); }}>
      <Menu.Portal>
        <Menu.Positioner positionMethod="fixed" anchor={anchor} className="z-80 outline-none" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Popup className="st-menu dd static proj-menu data-[ending-style]:pointer-events-none" finalFocus={() => returnFocusOnEscape.current && anchor instanceof HTMLElement ? anchor : false}>
            <div className="st-menu-head">Projects</div>
            <div className="max-w-[260px] px-2.5 pb-2.5 text-[12px] leading-[1.5] font-normal text-faint">Drag to reorder, the pencil renames. On the Station, Up and Down switch between them.</div>
            <div className="flex flex-col">
              {ordered.map((p) => (
                <div key={p.id} data-id={p.id} draggable={renaming !== p.id} className={`${ROW}${dragging === p.id ? ' dragging' : ''}${marks?.id === p.id ? marks.below ? ' drop-below' : ' drop-above' : ''}`}
                  onDragStart={(e) => { dragId.current = p.id; e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => setDragging(p.id), 0); }}
                  onDragEnd={() => { dragId.current = ''; setDragging(''); setMarks(null); }}
                  onDragOver={(e) => { if (!dragId.current || dragId.current === p.id) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); setMarks({ id: p.id, below: e.clientY > rect.top + rect.height / 2 }); }}
                  onDrop={(e) => { e.preventDefault(); const dragged = dragId.current; dragId.current = ''; setDragging(''); setMarks(null); if (!dragged || dragged === p.id) return; const ids = ordered.map((item) => item.id).filter((id) => id !== dragged); const at = ids.indexOf(p.id) + (marks?.id === p.id && marks.below ? 1 : 0); save([...ids.slice(0, at), dragged, ...ids.slice(at)]); }}
                  onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); startRename(p); return; } if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return; e.preventDefault(); e.stopPropagation(); const ids = ordered.map((item) => item.id); const i = ids.indexOf(p.id); save(moveId(ids, p.id, e.key === 'ArrowUp' ? i - 1 : i + 1)); focusItem(p.id); }}>
                  {renaming === p.id ? <div className="proj-rename-row flex min-h-8.75 min-w-0 flex-1 items-center gap-2.5 px-2.5"><span className="w-[13px] flex-none" /><Mark project={p} /><input ref={input} className="h-7 min-w-0 flex-1 px-2 py-0 text-[13.5px] leading-none" value={name} maxLength={80} aria-label={`New name for ${p.name}`} onChange={(e) => setName(e.currentTarget.value)} onBlur={() => finishRename(p, true)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finishRename(p, e.key === 'Enter'); focusItem(p.id); } }} /></div> : <DropdownItem render={<button type="button" />} nativeButton ref={(el: HTMLElement | null) => { if (el) items.current.set(p.id, el); else items.current.delete(p.id); }} className={`min-w-0 flex-1 ${p.id === active.id ? 'on' : ''}`} title="Drag to change the order (or Alt+Up / Alt+Down)" onClick={() => { close(); if (p.id !== active.id) void attempt(() => POST(`/projects/${p.id}/activate`), `Opened ${p.name}`).then(() => refreshSoon(0)); }}><Icon name="grip-vertical" size={13} className="flex-none cursor-grab text-faint" /><Mark project={p} /><span className="min-w-0 flex-1">{p.name}</span>{p.id === active.id ? <Icon name="check" size={14} /> : null}</DropdownItem>}
                  <button type="button" className={RENAME_BTN} title={`Rename ${p.name} (F2)`} aria-label={`Rename ${p.name}`} onClick={() => startRename(p)}><Icon name="pencil" size={13} /></button>
                </div>
              ))}
            </div>
            {actions.map((action) => <span key={action.label} className="contents">{action.separator ? <DropdownSeparator /> : null}<DropdownItem render={<button type="button" />} nativeButton icon={action.icon} danger={action.danger} onClick={() => { close(); void action.run(); }}>{action.label}</DropdownItem></span>)}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Dropdown>
  );
}
