// Settings > Look: UI scale, accent colour, animations. Changes apply right away and are saved a moment later.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Slider } from '@base-ui/react/slider';
import { PUT, attempt, state } from '../core.ts';
import { ACCENTS, DEFAULT_LOOK, applyLook } from '../look.ts';
import { Segmented } from '../ui/controls.tsx';
import { reactPage } from '../ui/react.tsx';
import type { LookSetting } from '../../shared/types.ts';

const SCALES = [80, 90, 100, 110, 125, 150];
const SAVE_AFTER = 350;

export function LookTab() {
  const [look, setLook] = useState<LookSetting>(() => ({ ...DEFAULT_LOOK, ...(state.data?.settings?.look || {}) }));
  // the scale while dragging: shown and applied live, saved when let go
  const [dragging, setDragging] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const set = (patch: Partial<LookSetting>) => {
    const next = { ...look, ...patch };
    setLook(next);
    setDragging(null);
    applyLook(next);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(async () => {
      const r = await attempt(() => PUT('/settings', { look: next }));
      if (r && state.data?.settings) state.data.settings.look = { ...next };
    }, SAVE_AFTER);
  };
  const scale = dragging ?? look.scale;

  return (
    <div className="two-col">
      <div className="col">
        <div className="panel">
          <div className="panel-head">
            <h2>UI scale</h2>
          </div>
          <p className="hint">Makes everything bigger or smaller: text, buttons, panels and the Station. Your browser zoom (Ctrl + / Ctrl −) still works on top of this.</p>
          <div className="look-scale mt">
            <span className="hint" aria-hidden="true">A</span>
            <Slider.Root
              className="look-slider"
              min={70}
              max={160}
              step={5}
              value={scale}
              format={{ style: 'unit', unit: 'percent', maximumFractionDigits: 0 }}
              onValueChange={(v) => {
                const n = Array.isArray(v) ? v[0] : v;
                setDragging(n);
                applyLook({ ...look, scale: n });
              }}
              onValueCommitted={(v) => set({ scale: Array.isArray(v) ? v[0] : v })}
            >
              <Slider.Control className="look-control">
                <Slider.Track className="look-track">
                  <Slider.Indicator className="look-fill" />
                  <Slider.Thumb className="look-thumb" aria-label="UI scale" />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>
            <span className="look-big" aria-hidden="true">A</span>
            <b className="look-pct">{`${scale}%`}</b>
          </div>
          <div className="row mt look-presets">
            {SCALES.map((v) => (
              <button key={v} className={`btn tiny${look.scale === v ? '' : ' ghost'}`} aria-pressed={look.scale === v} onClick={() => set({ scale: v })}>
                {v === 100 ? '100% (default)' : `${v}%`}
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Animations</h2>
          </div>
          <p className="hint">Panels sliding in, glows and pulses. Reduced keeps the Station moving but turns off most interface motion.</p>
          <div className="mt field">
            <span id="look-motion">Motion</span>
            <Segmented
              label="Motion"
              options={[
                { value: 'full', label: 'Full' },
                { value: 'reduced', label: 'Reduced' },
              ]}
              value={look.motion}
              onChange={(v) => set({ motion: v })}
            />
          </div>
        </div>
      </div>
      <div className="col">
        <div className="panel">
          <div className="panel-head">
            <h2 id="look-accent">Accent colour</h2>
          </div>
          <p className="hint">The highlight colour for buttons, active tabs, the status dots and focus rings.</p>
          <RadioGroup className="look-swatches mt" aria-labelledby="look-accent" value={look.accent} onValueChange={(v) => set({ accent: v as LookSetting['accent'] })}>
            {ACCENTS.map((a) => (
              <Radio.Root
                key={a.id}
                value={a.id}
                nativeButton
                render={<button type="button" />}
                className={(s) => `look-swatch${s.checked ? ' on' : ''}`}
                style={{ '--sw': a.c } as CSSProperties}
                title={a.label}
              >
                <span className="look-dot" aria-hidden="true" />
                <span>{a.label}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Preview</h2>
          </div>
          <div className="row look-preview">
            <button className="btn small">Button</button>
            <button className="btn ghost small">Ghost</button>
            <span className="pill ok">ready</span>
            <span>
              <span className="dot on" /> running
            </span>
          </div>
          <div className="row mt">
            <button className="btn ghost small" onClick={() => set({ ...DEFAULT_LOOK })}>Reset to default</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const title = () => 'Look';
export const { render, unmount } = reactPage(() => <LookTab />);
