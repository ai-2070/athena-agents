import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createAppRoot } from './ui/root.tsx';
import type { SkillListing } from '../shared/types.ts';
import { Button } from './ui/button.tsx';
import { PopoverContent, PopoverRoot } from './ui/popover.tsx';
import { Icon } from './ui/react.tsx';
import { SkillMark } from './skillmark.tsx';

interface PickerMenuProps {
  anchor: HTMLElement;
  skills: SkillListing[];
  select: (slug: string) => void;
  make: () => void;
  github: () => void;
  importClaude: () => void;
}

export function openSkillPickerMenu(props: PickerMenuProps): () => void {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createAppRoot(host);
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    root.render(<PickerMenu {...props} open={false} close={close} dispose={dispose} />);
  };
  const dispose = () => {
    if (open) return;
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  flushSync(() => root.render(<PickerMenu {...props} open close={close} dispose={dispose} />));
  return close;
}

function PickerMenu({
  anchor,
  skills,
  select,
  make,
  github,
  importClaude,
  open,
  close,
  dispose,
}: PickerMenuProps & { open: boolean; close: () => void; dispose: () => void }) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const shown = skills
    .filter((s) => !query || `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40);
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          close();
          if (details.reason === 'escape-key') anchor.focus();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) dispose();
      }}
    >
      <PopoverContent
        positioner={{ anchor }}
        aria-label="Add a skill"
        initialFocus={search}
        finalFocus={false}
        className="skp-menu skp-picker-menu w-[min(340px,calc(100vw-16px))] max-w-none data-[ending-style]:pointer-events-none"
      >
        <div className="st-menu-head">Add a skill</div>
        <div className="relative mb-1.5 px-0.5">
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
          />
          <input
            ref={search}
            className="w-full py-2 pr-2.5 pl-8 text-[13.5px]"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {shown.length ? (
            shown.map((s) => (
              <button
                key={s.slug}
                className="st-menu-item shrink-0 gap-3 py-2"
                type="button"
                title={s.description}
                onClick={() => {
                  close();
                  select(s.slug);
                }}
              >
                <SkillMark slug={s.slug} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-tight font-medium">{s.name}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] leading-tight font-normal text-faint">
                    {s.description}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="hint px-2.5 py-2">{skills.length ? 'No match.' : 'No more skills in the library.'}</div>
          )}
        </div>
        <div className="st-menu-sep" />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="tiny"
            className="flex-1 justify-center"
            type="button"
            onClick={() => {
              close();
              make();
            }}
          >
            <Icon name="plus" size={12} />
            New
          </Button>
          <Button
            variant="ghost"
            size="tiny"
            className="flex-1 justify-center"
            type="button"
            onClick={() => {
              close();
              github();
            }}
          >
            <Icon name="download" size={12} />
            From GitHub
          </Button>
          <Button
            variant="ghost"
            size="tiny"
            className="flex-1 justify-center"
            type="button"
            onClick={() => {
              close();
              importClaude();
            }}
          >
            <Icon name="terminal" size={12} />
            From Claude Code
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
