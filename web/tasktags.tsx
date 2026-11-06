// Tags on Tasks board tasks: the mark a tag shows as (its emoji and name), the picker that puts tags on a task (and
// makes new ones: "🐛 Bug" is the emoji and the name), the board's Tags filter, and the window that renames,
// re-emojis and deletes a project's tags. The rules (names, emoji, matching) are shared/boardtags.ts.
import { Popover } from '@base-ui/react/popover';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { confirmBox, onEvent, toast } from './core.ts';
import { rpc } from './client/rpc.ts';
import { Button, IconButton } from './ui/button.tsx';
import { Segmented } from './ui/controls.tsx';
import { Pill } from './ui/marks.tsx';
import { Icon } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import { PILL, ROW } from './taskboard.tsx';
import { splitTag, tagKey, tagLabel } from '../shared/boardtags.ts';
import type { TagMatch } from '../shared/boardtags.ts';
import type { BoardTag, BoardTagUse } from '../shared/types.ts';

const EmojiPicker = lazy(() => import('./ui/emojipicker.tsx').then((m) => ({ default: m.EmojiPicker })));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A tag as it shows on a card or a task: its emoji and its name. With onPick, a button (the board filters by it). */
export function TagMark({ tag, onPick }: { tag: Pick<BoardTag, 'name' | 'emoji'>; onPick?: () => void }) {
  const mark = (
    <Pill className="tag max-w-40" title={tagLabel(tag)}>
      {tag.emoji ? <span aria-hidden="true">{tag.emoji}</span> : null}
      <span className="min-w-0 truncate">{tag.name}</span>
    </Pill>
  );
  if (!onPick) return mark;
  return (
    <button type="button" className="tag-filter flex min-w-0 cursor-pointer rounded-full" aria-label={`Show tasks tagged ${tagLabel(tag)}`} onClick={(e) => (e.stopPropagation(), onPick())}>
      {mark}
    </button>
  );
}

/** Up to `max` tags, then "+2". */
export function TagMarks({ tags, max = 3, onPick }: { tags: readonly BoardTag[]; max?: number; onPick?: (t: BoardTag) => void }) {
  if (!tags.length) return null;
  const more = tags.length - max;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.slice(0, max).map((t) => <TagMark key={t.id} tag={t} onPick={onPick ? () => onPick(t) : undefined} />)}
      {more > 0 ? <span className="text-[11.5px] text-faint tabular-nums" title={tags.slice(max).map(tagLabel).join(', ')}>+{more}</span> : null}
    </span>
  );
}

/** A project's tags. While live they load, and load again when its board changes; otherwise the last ones stay
 *  (a closed tag menu doesn't ask for them on every comment or move). */
export function useBoardTags(projectId: string, live = true): { tags: BoardTagUse[] | null; reload: () => Promise<void> } {
  const [tags, setTags] = useState<BoardTagUse[] | null>(null);
  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setTags((await rpc.taskBoard.tags.list({ projectId })).tags);
    } catch {
      setTags((t) => t || []);
    }
  }, [projectId]);
  useEffect(() => setTags(null), [projectId]);
  useEffect(() => {
    if (!live) return;
    void reload();
    return onEvent((e) => e.type === 'board' && e.projectId === projectId && void reload());
  }, [projectId, reload, live]);
  return { tags, reload };
}

/** Makes a tag ("🐛 Bug" is the emoji and the name), or finds the one with that name (made: false). */
async function makeTag(projectId: string, name: string, emoji?: string): Promise<(BoardTagUse & { made: boolean }) | null> {
  try {
    return (await rpc.taskBoard.tags.add({ projectId, name, ...(emoji ? { emoji } : {}) })).tag;
  } catch (e) {
    toast(errorText(e), 'error');
    return null;
  }
}

/** The search box and the list of a tag menu. Enter picks the first match, or makes the tag that was typed. */
function TagSearch({ query, onQuery, onEnter, placeholder }: { query: string; onQuery: (q: string) => void; onEnter: () => void; placeholder: string }) {
  return (
    <input
      autoFocus
      aria-label={placeholder}
      placeholder={placeholder}
      value={query}
      maxLength={80}
      onChange={(e) => onQuery(e.currentTarget.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') (e.preventDefault(), onEnter());
      }}
      className="w-full rounded-ctl border border-line-2 bg-bg px-3 py-2 text-[13px] text-ink placeholder:text-faint"
    />
  );
}
function TagRow({ on, onClick, children, count }: { on: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={onClick} className="st-menu-item w-full">
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {count !== undefined ? <span className="text-[11.5px] text-faint tabular-nums">{count}</span> : null}
      <span className={`flex w-3.5 text-accent ${on ? '' : 'invisible'}`}><Icon name="check" size={14} /></span>
    </button>
  );
}
const tagText = (t: Pick<BoardTag, 'name' | 'emoji'>) => (
  <>
    <span className="w-4 flex-none text-center" aria-hidden="true">{t.emoji || <Icon name="tag" size={13} className="text-faint" />}</span>
    <span className="min-w-0 truncate">{t.name}</span>
  </>
);

/** Puts tags on a task (ids, in order): as a pill (the new task window) or a row (the task page). known: the tags
 *  the task has, to show them before the project's tags are loaded (they load when the menu opens). */
export function TagPicker({ projectId, value, known = [], onChange, look = 'pill', disabled }: { projectId: string; value: readonly string[]; known?: readonly BoardTag[]; onChange: (ids: string[]) => unknown; look?: 'pill' | 'row'; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { tags, reload } = useBoardTags(projectId, open);
  const [query, setQuery] = useState('');
  // (a tag made while other clicks were saved goes on the list as it is then, not as it was when the click began)
  const latest = useRef(value);
  latest.current = value;
  const all = tags || [];
  const picked = value.flatMap((id) => known.find((t) => t.id === id) ?? all.find((t) => t.id === id) ?? []);
  const key = tagKey(query);
  const shown = key ? all.filter((t) => tagKey(t.name).includes(key)) : all;
  const exact = key ? all.find((t) => tagKey(t.name) === key) : undefined;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const create = async () => {
    const made = await makeTag(projectId, query);
    if (!made) return;
    setQuery('');
    await reload();
    if (!latest.current.includes(made.id)) onChange([...latest.current, made.id]);
  };
  const typed = splitTag(query);
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o || setQuery(''))}>
      <Popover.Trigger className={look === 'pill' ? PILL : ROW} aria-label={`Tags: ${picked.length ? picked.map(tagLabel).join(', ') : 'none'}`} disabled={disabled || !projectId}>
        {look === 'row' ? <span className="w-24 flex-none text-dim">Tags</span> : null}
        {picked.length ? (
          <span className="flex min-w-0 flex-1 flex-wrap gap-1"><TagMarks tags={picked} max={look === 'row' ? 10 : 2} /></span>
        ) : (
          <>
            <Icon name="tag" size={14} className="text-faint" />
            <span className={look === 'row' ? 'text-faint' : ''}>{look === 'row' ? 'Add tags' : 'Tags'}</span>
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner positionMethod="fixed" className="z-96 outline-none" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup aria-label="Tags" className="st-menu dd static w-64 max-w-none p-1.5">
            <TagSearch query={query} onQuery={setQuery} placeholder="Find or make a tag" onEnter={() => (exact ? (toggle(exact.id), setQuery('')) : key ? void create() : undefined)} />
            <div role="menu" aria-label="Tags to choose" className="mt-1.5 flex max-h-64 flex-col overflow-y-auto">
              {shown.map((t) => <TagRow key={t.id} on={value.includes(t.id)} count={t.tasks} onClick={() => toggle(t.id)}>{tagText(t)}</TagRow>)}
              {key && !exact ? (
                <button type="button" onClick={() => void create()} className="st-menu-item w-full">
                  <Icon name="plus" size={14} />
                  <span className="min-w-0 flex-1 truncate">Make “{tagLabel(typed)}”</span>
                </button>
              ) : null}
              {!shown.length && !key ? <p className="m-0 px-2 py-2 text-[12.5px] text-dim">No tags yet. Type a name to make one; start it with an emoji to give it one.</p> : null}
            </div>
            <div className="st-menu-sep" />
            <button type="button" className="st-menu-item w-full" onClick={() => (setOpen(false), openTagManager(projectId))}>
              <Icon name="pencil" size={14} />
              Manage tags…
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One tag the board can filter by: same-named tags of several projects are one. */
export interface TagOption {
  key: string;
  name: string;
  emoji?: string;
  tasks: number;
}
/** The tags of the projects shown, merged by name, by name. */
export function tagOptions(byProject: Record<string, readonly BoardTagUse[]> | undefined): TagOption[] {
  const out = new Map<string, TagOption>();
  for (const list of Object.values(byProject || {})) {
    for (const t of list) {
      const key = tagKey(t.name);
      const had = out.get(key);
      out.set(key, had ? { ...had, emoji: had.emoji || t.emoji, tasks: had.tasks + t.tasks } : { key, name: t.name, ...(t.emoji ? { emoji: t.emoji } : {}), tasks: t.tasks });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export interface TagFilterValue {
  /** tag keys (shared/boardtags.ts tagKey) */
  keys: string[];
  untagged: boolean;
  match: TagMatch;
}
/** The filter without tags the projects shown no longer have (renamed, deleted, another project): left in, they
 *  would hide every card, and the menu couldn't untick them. The same value when nothing goes. */
export function knownTagFilter(value: TagFilterValue, options: readonly TagOption[]): TagFilterValue {
  const keys = value.keys.filter((k) => options.some((t) => t.key === k));
  return keys.length === value.keys.length ? value : { ...value, keys };
}
/** The board's Tags filter: tags to show (any or all of them), and tasks with no tag. */
export function TagFilter({ options, value, onChange, projectId }: { options: readonly TagOption[]; value: TagFilterValue; onChange: (v: TagFilterValue) => void; projectId?: string }) {
  const [query, setQuery] = useState('');
  const key = tagKey(query);
  const shown = useMemo(() => (key ? options.filter((t) => t.key.includes(key)) : options), [options, key]);
  const picked = value.keys.flatMap((k) => options.filter((t) => t.key === k));
  const toggle = (k: string) => onChange({ ...value, keys: value.keys.includes(k) ? value.keys.filter((x) => x !== k) : [...value.keys, k] });
  const count = value.keys.length + (value.untagged ? 1 : 0);
  const label = !count ? 'Tags' : count > 1 ? `${count} tags` : value.untagged ? 'No tags' : picked[0] ? tagLabel(picked[0]) : '1 tag';
  return (
    <Popover.Root onOpenChange={(o) => o || setQuery('')}>
      <Popover.Trigger className={PILL} aria-label={`Tags shown: ${count ? label : 'any'}`}>
        <Icon name="tag" size={14} className="text-faint" />
        <span className="min-w-0 truncate">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner positionMethod="fixed" className="z-96 outline-none" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup aria-label="Tags shown" className="st-menu dd static w-64 max-w-none p-1.5">
            {options.length > 6 ? <TagSearch query={query} onQuery={setQuery} placeholder="Find a tag" onEnter={() => shown[0] && toggle(shown[0].key)} /> : null}
            {value.keys.length > 1 ? (
              <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1 text-[12.5px] text-dim">
                Tasks with
                <Segmented label="Tasks with" value={value.match} onChange={(match) => onChange({ ...value, match })} options={[{ value: 'any', label: 'Any' }, { value: 'all', label: 'All' }]} />
              </div>
            ) : null}
            <div role="menu" aria-label="Tags to show" className="mt-1 flex max-h-72 flex-col overflow-y-auto">
              {shown.map((t) => <TagRow key={t.key} on={value.keys.includes(t.key)} count={t.tasks} onClick={() => toggle(t.key)}>{tagText(t)}</TagRow>)}
              {!options.length ? <p className="m-0 px-2 py-2 text-[12.5px] text-dim">No tags yet. Add them on a task.</p> : null}
              {!key ? (
                <TagRow on={value.untagged} onClick={() => onChange({ ...value, untagged: !value.untagged })}>
                  <span className="w-4 flex-none text-center text-faint" aria-hidden="true"><Icon name="minus" size={13} /></span>
                  No tags
                </TagRow>
              ) : null}
            </div>
            {projectId ? (
              <>
                <div className="st-menu-sep" />
                <button type="button" className="st-menu-item w-full" onClick={() => openTagManager(projectId)}>
                  <Icon name="pencil" size={14} />
                  Manage tags…
                </button>
              </>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------- Manage tags ----------
/** "Manage tags": a project's tags, to make, rename, give an emoji and delete. */
export function openTagManager(projectId: string): void {
  openModal(
    <span className="inline-flex items-center gap-1.5 text-[14px]">
      <Icon name="tag" size={15} />
      Tags
    </span>,
    () => <TagManager projectId={projectId} />,
    { narrow: true },
  );
}

function EmojiButton({ value, onChange, label }: { value: string; onChange: (emoji: string) => void; label: string }) {
  const face = value ? <span className="text-[17px]">{value}</span> : <Icon name="smiley" size={16} className="text-faint" />;
  return (
    <Suspense fallback={<span className="flex size-8 items-center justify-center">{face}</span>}>
      <EmojiPicker value={value} onChange={onChange} label={label} className="size-8! rounded-ctl p-0!">{face}</EmojiPicker>
    </Suspense>
  );
}

export function TagManager({ projectId }: { projectId: string }) {
  const { tags, reload } = useBoardTags(projectId);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const add = async () => {
    if (!name.trim()) return;
    const made = await makeTag(projectId, name, emoji);
    if (!made) return;
    // (the form stays, so a name that is taken can be changed)
    if (!made.made) return void toast(`There's a tag called “${tagLabel(made)}” already.`);
    setName('');
    setEmoji('');
    await reload();
  };
  const change = async (t: BoardTagUse, patch: { name?: string; emoji?: string }): Promise<boolean> => {
    let ok = true;
    try {
      await rpc.taskBoard.tags.change({ projectId, tagId: t.id, ...patch });
    } catch (e) {
      toast(errorText(e), 'error');
      ok = false;
    }
    await reload();
    return ok;
  };
  const remove = async (t: BoardTagUse) => {
    const ok = await confirmBox(`Delete the tag “${tagLabel(t)}”?${t.tasks ? ` It comes off ${t.tasks} task${t.tasks === 1 ? '' : 's'}.` : ''}`, { ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      await rpc.taskBoard.tags.remove({ projectId, tagId: t.id });
    } catch (e) {
      toast(errorText(e), 'error');
    }
    await reload();
  };
  return (
    <div className="modal-body flex flex-col gap-3">
      <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), void add())}>
        <EmojiButton value={emoji} onChange={setEmoji} label="Choose the new tag's emoji" />
        <input aria-label="New tag" placeholder="New tag, e.g. Bug" value={name} maxLength={80} onChange={(e) => setName(e.currentTarget.value)} className="min-w-0 flex-1" />
        <Button type="submit" size="small" disabled={!name.trim()}>Add tag</Button>
      </form>
      {tags === null ? null : tags.length ? (
        <ul aria-label="The project's tags" className="m-0 flex list-none flex-col p-0">
          {tags.map((t) => (
            <li key={`${t.id}:${t.name}:${t.emoji || ''}`} className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0">
              <EmojiButton value={t.emoji || ''} onChange={(e) => void change(t, { emoji: e })} label={`Choose an emoji for ${t.name}`} />
              <input
                aria-label={`Name of ${t.name}`}
                defaultValue={t.name}
                maxLength={80}
                className="min-w-0 flex-1 border-transparent! bg-transparent! shadow-none! hover:border-line-2! focus:border-line-2!"
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
                onBlur={(e) => {
                  const input = e.currentTarget;
                  const next = input.value.trim();
                  // (a refused name goes back to the tag's own: the row isn't drawn again, as nothing changed)
                  if (next && next !== t.name) void change(t, { name: next }).then((ok) => ok || (input.value = t.name));
                  else input.value = t.name;
                }}
              />
              <span className="flex-none text-[12px] text-faint tabular-nums">{t.tasks} task{t.tasks === 1 ? '' : 's'}</span>
              {/* (its place stays when there is no emoji, so the rows line up) */}
              {t.emoji ? (
                <IconButton variant="plain" aria-label={`Take the emoji off ${t.name}`} title="Take the emoji off" onClick={() => void change(t, { emoji: '' })}>
                  <Icon name="x" size={14} />
                </IconButton>
              ) : (
                <IconButton variant="plain" aria-hidden="true" tabIndex={-1} disabled className="invisible">
                  <Icon name="x" size={14} />
                </IconButton>
              )}
              <IconButton variant="plain" aria-label={`Delete the tag ${t.name}`} title="Delete the tag" onClick={() => void remove(t)}>
                <Icon name="trash-2" size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-dim">No tags yet. Add one above, or type a new name in a task's Tags.</p>
      )}
    </div>
  );
}
