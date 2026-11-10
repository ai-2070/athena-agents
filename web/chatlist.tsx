// The Tasks row of the Brain chat, a team's chat or an agent's tab, with the earlier chats beside it: "Chats" opens them
// below the row the way "Tasks" opens the tasks (one of the two at a time). The list is newest first and grouped by
// day, with the open one first (whatever order they came in). Click one to open it; the bin deletes one (after asking); a search box shows once the
// list is long. Each place says how its chats are listed, opened and deleted. (New chat is a button of its own.)
import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { ago, confirmBox, dayGroups, dayOf } from './core.ts';
import { latestLoad } from './brainqueue.ts';
import { TaskPanel } from './tasks.tsx';
import { CollapsePanel, CollapseRoot } from './ui/collapse.tsx';
import { Icon } from './ui/react.tsx';
import { Button, IconButton } from './ui/button.tsx';

/** One chat in the list. open: the one shown now. */
export interface ChatListItem {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
  open: boolean;
}

export interface ChatListProps {
  /** The chats, in any order (asked for each time the list opens): the list puts the open one first, then the newest. */
  load: () => Promise<ChatListItem[]>;
  onOpen: (item: ChatListItem) => unknown;
  /** Deletes one (it was asked first); true once it is gone. */
  onRemove: (item: ChatListItem) => Promise<boolean>;
  /** What deleting one does, said when asking. */
  removeNote?: string | ((item: ChatListItem) => string);
  /** At the end of the row (a team's New chat). */
  end?: ReactNode;
  /** Goes up each time another chat is shown (New chat, or one opened from another tab): the list closes. */
  switched?: number;
}

// a search box once there are more than this
const FIND_FROM = 8;

/** The Tasks row (tasks: TaskPanel's props) with the earlier chats beside it. */
export function TasksAndChats({ tasks, chats }: { tasks: Omit<ComponentProps<typeof TaskPanel>, 'share'>; chats: ChatListProps }) {
  const [shown, setShown] = useState<'tasks' | 'chats' | null>(null);
  const open = shown === 'chats';
  const panelId = useId();
  const [items, setItems] = useState<ChatListItem[] | null>(null);
  const [failed, setFailed] = useState('');
  const [find, setFind] = useState('');
  // (only the newest load counts)
  const loads = useRef(latestLoad()).current;
  const reload = () => {
    const current = loads.start();
    chats.load()
      .then((list) => current() && (setItems(list), setFailed('')))
      .catch((e: unknown) => current() && setFailed(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    if (!open) return;
    setFind('');
    reload();
    // (asked for again each time it opens)
  }, [open]);
  // another chat is shown now: the list is done with
  useEffect(() => {
    if (chats.switched) setShown((s) => (s === 'chats' ? null : s));
  }, [chats.switched]);

  // empty chats aren't listed, except the open one (so you can see where you are); it comes first, then the newest
  const listed = (items || []).filter((c) => c.count > 0 || c.open).sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt - a.updatedAt);
  const q = find.trim().toLowerCase();
  const found = q ? listed.filter((c) => c.title.toLowerCase().includes(q)) : listed;
  const groups = dayGroups(found, (c) => (c.open ? 'Open now' : dayOf(c.updatedAt)));
  const earlier = listed.filter((c) => !c.open).length;

  const pick = (c: ChatListItem) => {
    setShown(null);
    if (!c.open) chats.onOpen(c);
  };
  const remove = async (c: ChatListItem) => {
    const what = c.open ? 'Delete this chat? It is the one open now, so it empties.' : `Delete “${c.title}”?`;
    const note = typeof chats.removeNote === 'function' ? chats.removeNote(c) : chats.removeNote;
    if (!(await confirmBox(`${what}${note ? ` ${note}` : ''}`, { ok: 'Delete', danger: true }))) return;
    if (await chats.onRemove(c)) reload();
  };

  const toggle = (
    <>
      <Button variant="plain" size="tiny" className="chat-list-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setShown(open ? null : 'chats')}>
        <Icon name="history" size={15} />
        Chats
        <Icon name="chevron-down" size={12} className={`transition-transform duration-200 ease-in-out ${open ? '' : '-rotate-90'}`} />
      </Button>
      {open ? (
        <span className="min-w-0 flex-1 text-dim" aria-live="polite">
          {items ? `${earlier} earlier` : ''}
        </span>
      ) : null}
    </>
  );
  return (
    <div className="flex min-w-0 items-start gap-1">
      <CollapseRoot open={open} onOpenChange={(o) => setShown(o ? 'chats' : null)} render={<div />} className="min-w-0 flex-1">
        <TaskPanel {...tasks} share={{ beside: toggle, open: shown === 'tasks', onOpenChange: (o) => setShown(o ? 'tasks' : null) }} />
        <CollapsePanel id={panelId}>
          <div className="chat-list mx-1 max-h-[min(45vh,340px)] overflow-y-auto border-y border-line pt-2 pb-1 text-[13px]" aria-label="Chats">
            {listed.length > FIND_FROM ? (
              <div className="relative mb-2">
                <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dim" />
                <input type="search" className="w-full pl-9" aria-label="Find a chat" placeholder="Find a chat…" value={find} onChange={(e) => setFind(e.currentTarget.value)} />
              </div>
            ) : null}
            {failed ? <p role="alert" className="m-0 py-2 text-red">{failed}</p> : null}
            {!items && !failed ? <p role="status" className="m-0 py-2 text-dim">Loading chats…</p> : null}
            {groups.map((g) => (
              <div key={g.day} className="flex flex-col gap-px pb-1" role="group" aria-label={g.day}>
                <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-faint">{g.day}</div>
                {g.list.map((c) => (
                  <div key={c.id} className="chat-list-row group/row relative flex items-center">
                    <button
                      type="button"
                      className={`st-menu-item min-w-0 flex-1 pr-9! ${c.open ? 'on' : ''}`}
                      aria-current={c.open ? 'true' : undefined}
                      title={`${c.title} · ${c.count} message${c.count === 1 ? '' : 's'}`}
                      onClick={() => pick(c)}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      {/* (the bin takes the time's place while you point at the row) */}
                      <span className="flex-none text-[11px] text-faint tabular-nums group-hover/row:invisible group-focus-within/row:invisible">{c.count ? ago(c.updatedAt) : 'empty'}</span>
                    </button>
                    <IconButton
                      variant="quiet"
                      className="chat-list-remove absolute right-1 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
                      title="Delete this chat"
                      aria-label={`Delete ${c.title}`}
                      onClick={() => void remove(c)}
                    >
                      <Icon name="trash-2" size={14} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
            {items && !earlier && !q ? <p className="m-0 px-2 pt-1 pb-2 text-dim">No earlier chats. Start a new chat and this one is kept here.</p> : null}
            {q && !found.length ? <p className="m-0 px-2 py-2 text-dim">No chat matches.</p> : null}
          </div>
        </CollapsePanel>
      </CollapseRoot>
      {chats.end ? <div className="flex flex-none items-center pt-1">{chats.end}</div> : null}
    </div>
  );
}
