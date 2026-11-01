// The schedule editor (Manual / Every… / Daily) used by workflows and routines.
// React now: it is rendered through createRoot into a detached div, edits item.schedule/item.enabled
// in place and shares the app's controls.
import { useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { scheduleText, DAY_NAMES as DAYS } from '../shared/routines.ts';
import type { Schedule } from '../shared/types.ts';
import { TimePicker } from './ui/timepicker.tsx';
import { Button, IconButton } from './ui/button.tsx';
import { Icon } from './ui/react.tsx';
import { Chip } from './ui/marks.tsx';
import { Field, Segmented, SwitchRow } from './ui/controls.tsx';
import { CHIPS_CLASS } from './ui/classes.ts';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MIN_MINUTES = 5;

export { scheduleText };

/** Edits item.schedule and item.enabled in place; onChange runs after every edit. */
export function scheduleEditor(item: { schedule?: Schedule; enabled?: boolean }, onChange: () => void, { inputLabel = 'Input for scheduled runs', showToggle = true }: { inputLabel?: string; /** false: the page has its own on/off switch. */ showToggle?: boolean } = {}): HTMLDivElement {
  item.schedule ||= { type: 'none' };
  const host = document.createElement('div');
  createRoot(host).render(<Editor item={item} onChange={onChange} inputLabel={inputLabel} showToggle={showToggle} />);
  return host;
}

function Editor({ item, onChange, inputLabel, showToggle }: { item: { schedule?: Schedule; enabled?: boolean }; onChange: () => void; inputLabel: string; showToggle: boolean }) {
  const [, redraw] = useState(0);
  const timesId = useId();
  const s = item.schedule!;
  const times = s.times?.length ? s.times : ['09:00'];
  // mutate item in place, tell the caller, and draw the new state
  const mark = () => {
    onChange();
    redraw((n) => n + 1);
  };
  // the number input's change (leaving it) rewrites the value to the clamped one;
  // its value is kept at the minimum the scheduler uses, so what you see is how often it runs
  const clampMinutes = (el: HTMLInputElement | null) => {
    if (el) el.onchange = () => (el.value = String(s.minutes));
  };
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        options={[
          { value: 'none', label: 'Manual' },
          { value: 'interval', label: 'Every…' },
          { value: 'daily', label: 'Daily' },
        ]}
        value={s.type}
        onChange={(v) => ((item.schedule!.type = v), mark())}
        label="Schedule"
      />
      <div className="flex flex-col gap-4 empty:hidden">
        {s.type === 'interval' ? (
          <Field label="Every (minutes)" hint={`At least ${MIN_MINUTES} minutes.`}>
            <input
              type="number"
              min={MIN_MINUTES}
              defaultValue={s.minutes || 60}
              onInput={(e) => ((s.minutes = Math.max(MIN_MINUTES, Number(e.currentTarget.value) || 60)), mark())}
              ref={clampMinutes}
            />
          </Field>
        ) : null}
        {s.type === 'daily' ? (
          <div className="flex flex-col gap-4">
            <Field label="Times" group={timesId}>
              <div className="flex flex-col gap-2">
                {times.map((time, index) => <div key={index} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1"><TimePicker label={`Time ${index + 1}`} value={time} onChange={(value) => {
                    s.times = times.map((old, i) => i === index ? value : old);
                    mark();
                  }} /></div>
                  <IconButton variant="plain" aria-label={`Remove time ${index + 1}`} disabled={times.length === 1} onClick={() => { s.times = times.filter((_, i) => i !== index); mark(); }}><Icon name="x" size={14} /></IconButton>
                </div>)}
                <Button variant="ghost" size="small" className="self-start" disabled={times.length >= 1440} onClick={() => {
                  const [hour, minute] = times[times.length - 1].split(':').map(Number);
                  let next = ((hour || 0) * 60 + (minute || 0) + 60) % 1440;
                  const format = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
                  while (times.includes(format(next))) next = (next + 1) % 1440;
                  s.times = [...times, format(next)];
                  mark();
                }}><Icon name="plus" size={13} />Add time</Button>
              </div>
            </Field>
            <div className={CHIPS_CLASS}>
              {DAYS.map((d, i) => {
                const days = s.days?.length ? s.days : EVERY_DAY;
                return (
                  <Chip
                    key={d}
                    on={days.includes(i)}
                    onClick={() => {
                      const cur = new Set(s.days?.length ? s.days : EVERY_DAY);
                      cur.has(i) ? cur.delete(i) : cur.add(i);
                      s.days = [...cur].sort();
                      mark();
                    }}
                  >
                    {d}
                  </Chip>
                );
              })}
            </div>
          </div>
        ) : null}
        {s.type !== 'none' ? (
          <Field label={inputLabel}>
            <input defaultValue={s.input || ''} onInput={(e) => ((s.input = e.currentTarget.value), mark())} />
          </Field>
        ) : null}
        {s.type !== 'none' && showToggle ? <SwitchRow checked={!!item.enabled} onChange={(v) => ((item.enabled = v), mark())} title="Schedule on (runs while the dashboard is open)" /> : null}
      </div>
    </div>
  );
}
