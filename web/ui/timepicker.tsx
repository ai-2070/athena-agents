// ReUI's c-time-picker-2 pattern, adapted to the app's Base UI popover and controls.
// Reference: https://reui.io/components/time-picker (Now/Clear stay drafts until OK).
import { timeText } from '../../shared/routines.ts';
import { Popover } from '@base-ui/react/popover';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Button } from './button.tsx';
import { fieldTriggerClass } from './classes.ts';
import { Icon } from './react.tsx';
import { PopoverContent, PopoverRoot } from './popover.tsx';

const pad = (value: number) => String(value).padStart(2, '0');
const displayTime = (value: string) => (value ? timeText(value) : 'Select time');
const nowTime = () => {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

export function TimePicker({
  value,
  onChange,
  label = 'Time',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const hours = useRef<HTMLDivElement>(null);
  const minutes = useRef<HTMLDivElement>(null);
  const periods = useRef<HTMLDivElement>(null);
  const id = useId();
  const [hour, minute] = (draft || '00:00').split(':').map(Number);
  const choose = (unit: 'hour' | 'minute' | 'period', next: number) => {
    const nextHour =
      unit === 'hour' ? ((next + 1) % 12) + (hour >= 12 ? 12 : 0) : unit === 'period' ? (hour % 12) + next * 12 : hour;
    setDraft(`${pad(nextHour)}:${pad(unit === 'minute' ? next : minute)}`);
  };
  useEffect(() => {
    if (!open) return;
    for (const list of [hours.current, minutes.current, periods.current]) {
      const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (list && selected)
        list.scrollTop = selected.offsetTop - list.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2;
    }
  }, [open, draft]);
  const column = (
    unit: 'hour' | 'minute' | 'period',
    count: number,
    current: number,
    ref: RefObject<HTMLDivElement | null>,
    previous: RefObject<HTMLDivElement | null>,
    nextColumn: RefObject<HTMLDivElement | null>,
  ) => {
    const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1) % count;
      else if (event.key === 'ArrowUp') next = (current + count - 1) % count;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = count - 1;
      else if (event.key === 'PageDown') next = Math.min(count - 1, current + 5);
      else if (event.key === 'PageUp') next = Math.max(0, current - 5);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        (event.key === 'ArrowLeft' ? previous : nextColumn).current?.focus();
        return;
      } else return;
      event.preventDefault();
      choose(unit, next);
    };
    return (
      <div className="min-w-0 px-2 py-3">
        <div id={`${id}-${unit}-label`} className="px-2 pb-2 text-center text-[12px] font-medium text-dim">
          {unit === 'hour' ? 'Hour' : unit === 'minute' ? 'Minute' : 'AM/PM'}
        </div>
        <div
          ref={ref}
          role="listbox"
          aria-labelledby={`${id}-${unit}-label`}
          aria-activedescendant={`${id}-${unit}-${current}`}
          tabIndex={0}
          onKeyDown={keyDown}
          className="relative flex h-44 flex-col gap-1 overflow-y-auto rounded-ctl p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {Array.from({ length: count }, (_, number) => (
            <Button
              key={number}
              id={`${id}-${unit}-${number}`}
              type="button"
              role="option"
              aria-selected={!!draft && number === current}
              tabIndex={-1}
              variant={draft && number === current ? 'primary' : 'plain'}
              size="small"
              className="w-full shrink-0 font-mono"
              onClick={() => {
                ref.current?.focus();
                choose(unit, number);
              }}
            >
              {unit === 'hour' ? pad(number + 1) : unit === 'period' ? (number ? 'PM' : 'AM') : pad(number)}
            </Button>
          ))}
        </div>
      </div>
    );
  };
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(value);
        setOpen(next);
      }}
    >
      <Popover.Trigger
        type="button"
        data-time-picker
        aria-label={`${label}: ${displayTime(value)}`}
        className={fieldTriggerClass('field', 'justify-between font-mono')}
      >
        <span className={value ? 'text-ink' : 'text-faint'}>{displayTime(value)}</span>
        <Icon name="clock" size={16} />
      </Popover.Trigger>
      <PopoverContent aria-label={`${label} picker`} initialFocus={hours} className="w-72 p-0">
        <div className="grid grid-cols-3 divide-x divide-line">
          {column('hour', 12, ((hour % 12) + 11) % 12, hours, periods, minutes)}
          {column('minute', 60, minute, minutes, hours, periods)}
          {column('period', 2, hour >= 12 ? 1 : 0, periods, minutes, hours)}
        </div>
        <div className="flex items-center gap-1.5 border-t border-line p-3">
          <Button type="button" variant="ghost" size="small" onClick={() => setDraft(nowTime())}>
            Now
          </Button>
          <Button type="button" variant="plain" size="small" onClick={() => setDraft('')}>
            Clear
          </Button>
          <Button
            type="button"
            size="small"
            className="ml-auto"
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            OK
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
