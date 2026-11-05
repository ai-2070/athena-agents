import { Popover } from '@base-ui/react/popover';
import data from '@emoji-mart/data/sets/15/native.json';
import type { EmojiMartData } from '@emoji-mart/data';
import { useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { buttonClass } from './classes.ts';

const emojiData: EmojiMartData = data;
const categories: Record<string, string> = {
  people: 'People',
  nature: 'Nature',
  foods: 'Food',
  activity: 'Activity',
  places: 'Places',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

const emojis = emojiData.categories.flatMap((category) => category.emojis.flatMap((id) => {
  const emoji = emojiData.emojis[id];
  const native = emoji?.skins[0]?.native;
  return native ? [{ id, category: category.id, native, name: emoji.name, search: `${emoji.name} ${id.replace(/[_-]/g, ' ')} ${emoji.keywords.join(' ')}`.toLowerCase() }] : [];
}));

/** className: the trigger's size and shape (a large square by default, as on an agent's page). */
export function EmojiPicker({ value, onChange, children, className = 'size-15! rounded-[14px] p-0!', label = 'Choose emoji' }: { value: string; onChange: (emoji: string) => void; children: ReactNode; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('people');
  const [active, setActive] = useState<string | null>(null);
  const results = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return emojis.filter((emoji) => terms.length ? terms.every((term) => emoji.search.includes(term)) : emoji.category === category);
  }, [query, category]);
  const activeId = results.some((emoji) => emoji.id === active) ? active : results[0]?.id;

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
    const offset = offsets[event.key];
    if (offset === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : Math.max(0, Math.min(results.length - 1, index + (offset ?? 0)));
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[next]?.focus();
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className={buttonClass('ghost', undefined, className)} aria-label={label} title={label}>{children}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner positionMethod="fixed" className="z-96 outline-none" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
            <Popover.Popup aria-label="Choose emoji" className="st-menu dd static w-[min(320px,calc(100vw-16px))] max-w-none p-2">
              <input aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={(event) => { setQuery(event.target.value); setActive(null); }} className="w-full rounded-ctl border border-line-2 bg-bg px-3 py-2 text-[13.5px] text-ink placeholder:text-faint" />
              {!query.trim() && <div aria-label="Emoji categories" className="mt-2 flex gap-1 overflow-x-auto pb-1">
                {emojiData.categories.map((item) => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setActive(null); }} className={`shrink-0 cursor-pointer rounded-ctl px-2 py-1 text-[12px] ${category === item.id ? 'bg-panel-2 text-ink' : 'text-dim hover:bg-panel-2 hover:text-ink'}`}>{categories[item.id] ?? item.id}</button>)}
              </div>}
              <div className="px-1 pt-2 pb-1 text-[12px] text-dim">{query.trim() ? 'Search results' : categories[category]}</div>
              {results.length ? <div aria-label="Emoji choices" className="grid max-h-60 grid-cols-8 overflow-y-auto">
                {results.map((emoji, index) => <button key={emoji.id} type="button" aria-label={emoji.name} aria-pressed={value === emoji.native} title={emoji.name} tabIndex={emoji.id === activeId ? 0 : -1} onFocus={() => setActive(emoji.id)} onKeyDown={(event) => moveFocus(event, index)} onClick={() => { onChange(emoji.native); setOpen(false); }} className="aspect-square cursor-pointer rounded-ctl text-[21px] hover:bg-panel-2 focus-visible:bg-panel-2 aria-pressed:bg-accent/10">{emoji.native}</button>)}
              </div> : <p role="status" className="px-1 py-4 text-[13px] text-dim">No emoji found. Try another search.</p>}
              <label className="mt-2 flex items-center gap-2 px-1 text-[12px] text-dim">
                Your emoji
                <input aria-label="Icon" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Type or paste" className="min-w-0 flex-1 rounded-ctl border border-line-2 bg-bg px-2 py-1 text-[14px] text-ink" />
              </label>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
    </Popover.Root>
  );
}
