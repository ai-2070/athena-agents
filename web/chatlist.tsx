// The earlier chats of the Brain chat, a team's chat or an agent's tab: a button that opens the list, newest first and
// grouped by day, with the open one marked. Click one to open it; the bin deletes one (after asking); a search box
// shows once the list is long. Each place says how its chats are listed, opened and deleted. (New chat is a button of
// its own beside this one.)
import { Popover } from '@base-ui/react/popover';
import { useEffect, useRef, useState } from 'react';
import { ago, confirmBox, dayOf } from './core.ts';
import { Icon } from './ui/react.tsx';
import { iconButtonClass } from './ui/classes.ts';
import type { IconButtonVariant } from './ui/classes.ts';

/** One chat in the list. open: the one shown now. */
export interface ChatListItem {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
  open: boolean;
}

export interface ChatListProps {
  /** The chats, newest first (asked for each time the list opens). */
  load: () => Promise<ChatListItem[]>;
  onOpen: (item: ChatListItem) => unknown;
  /** Deletes one (it was asked first); true once it is gone. */
  onRemove: (item: ChatListItem) => Promise<boolean>;
  /** What deleting one does, said when asking. */
  removeNote?: string;
  /** The button's look (it sits in a window's header, or in a row of small buttons). */
  variant?: IconButtonVariant;
  size?: number;
}

// a search box once there are more than this
const FIND_FROM = 8;

export function ChatList({ load, onOpen, onRemove, removeNote = '', variant = 'plain', size = 16 }: ChatListProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChatListItem[] | null>(null);
  const [failed, setFailed] = useState('');
  const [find, setFind] = useState('');
  // (only the newest load counts)
  const serial = useRef(0);
  const reload = () => {
    const n = ++serial.current;
    load()
      .then((list) => n === serial.current && (setItems(list), setFailed('')))
      .catch((e: unknown) => n === serial.current && setFailed(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    if (!open) return;
    setFind('');
    reload();
    // (the list is asked for again each time it opens; load changes with what it lists)
  }, [open]);

  // empty chats aren't listed, except the open one (so you can see where you are)
  const listed = (items || []).filter((c) => c.count > 0 || c.open);
  const q = find.trim().toLowerCase();
  const shown = q ? listed.filter((c) => c.title.toLowerCase().includes(q)) : listed;
  const groups: { day: string; list: ChatListItem[] }[] = [];
  for (const c of shown) {
    // (the open one heads the list, under the day it was last used)
    const day = c.open ? 'Open now' : dayOf(c.updatedAt);
    if (groups.at(-1)?.day === day) groups.at(-1)!.list.push(c);
    else groups.push({ day, list: [c] });
  }

  const pick = (c: ChatListItem) => {
    setOpen(false);
    if (!c.open) onOpen(c);
  };
  const remove = async (c: ChatListItem) => {
    // (the list stays open behind the question)
    const what = c.open ? 'Delete this chat? It is the one open now, so it empties.' : `Delete “${c.title}”?`;
    if (!(await confirmBox(`${what}${removeNote ? ` ${removeNote}` : ''}`, { ok: 'Delete', danger: true }))) return;
    if (await onRemove(c)) reload();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={iconButtonClass(variant, 'chat-list-btn flex-none')} title="Earlier chats" aria-label="Earlier chats">
        <Icon name="history" size={size} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner positionMethod="fixed" className="z-96 outline-none" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          <Popover.Popup aria-label="Chats" className="chat-list st-menu dd static flex w-80 max-w-[calc(100vw-16px)] flex-col p-1.5">
            {listed.length > FIND_FROM ? (
              <label className="relative mb-1.5 block">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint">
                  <Icon name="search" size={13} />
                </span>
                <input className="h-8! py-0! pl-8! text-[12.5px]!" aria-label="Find a chat" placeholder="Find a chat" value={find} onChange={(e) => setFind(e.currentTarget.value)} />
              </label>
            ) : null}
            <div className="flex max-h-[min(420px,60vh)] flex-col overflow-y-auto">
              {failed ? <p className="m-0 px-2 py-2 text-[12.5px] text-red">{failed}</p> : null}
              {!items && !failed ? <p className="m-0 px-2 py-2 text-[12.5px] text-faint">Loading…</p> : null}
              {groups.map((g) => (
                <div key={g.day} className="flex flex-col gap-px pb-1" role="group" aria-label={g.day}>
                  <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">{g.day}</div>
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
                      <button
                        type="button"
                        className="chat-list-remove absolute right-1 flex size-7 items-center justify-center rounded-ctl text-faint opacity-0 hover:bg-red/10 hover:text-red focus-visible:opacity-100 group-hover/row:opacity-100"
                        title="Delete this chat"
                        aria-label={`Delete ${c.title}`}
                        onClick={() => void remove(c)}
                      >
                        <Icon name="trash-2" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {items && !listed.length ? <p className="m-0 px-2 py-2 text-[12.5px] text-faint">No chats yet.</p> : null}
              {items && listed.length === 1 && listed[0].open && !q ? <p className="m-0 px-2 pt-1 pb-2 text-[12.5px] text-faint">Start a new chat and this one is kept here.</p> : null}
              {q && !shown.length ? <p className="m-0 px-2 py-2 text-[12.5px] text-faint">No chat matches.</p> : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
