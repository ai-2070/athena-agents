// Settings > Appearance: UI scale, accent colour, animations, chat font, Station quality. Changes apply right away and are saved a moment later.
// The Station's background picture and its opacities belong to the open project (not the settings).
import { Button } from '../ui/button.tsx';
import { Dot, Pill } from '../ui/marks.tsx';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Slider } from '@base-ui/react/slider';
import { attempt, state } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { rememberSidebarPanel } from '../navlimits.tsx';
import { ACCENTS, CHAT_FONTS, DEFAULT_LOOK, STATION_QUALITY, accentFor, accentTone, applyLook, stationLevel } from '../look.ts';
import { onThemeChange } from '../theme.ts';
import { Row, Section, Segmented } from '../ui/controls.tsx';
import { Icon, reactPage, useAppState } from '../ui/react.tsx';
import { backgroundUrl, pickBackground, removeBackground } from '../projectlogo.ts';
import { BACKGROUND_OPACITY, backgroundOpacity, mapDotsOpacity } from '../../shared/look.ts';
import type { LookSetting, Project } from '../../shared/types.ts';

const SCALES = [80, 90, 100, 110, 125, 150];
const SAVE_AFTER = 350;
// an accent colour to pick, in its own colour (--sw): a round dot and its name; on: the picked one gets a border in that colour
const SWATCH = 'flex cursor-pointer items-center gap-3 rounded-box border border-line bg-panel px-4 py-3.5 text-[14px] font-medium text-ink shadow-[inset_0_1px_0_var(--glass-spec)] transition-[border-color,background-color] duration-150 hover:bg-panel-2 [&.on]:border-(--sw)';
// a chat font to pick: its name in that font, and whose look it matches
const FONT = 'look-font flex cursor-pointer flex-col items-start gap-1 rounded-box border border-line bg-panel px-4 py-3.5 text-left text-ink shadow-[inset_0_1px_0_var(--glass-spec)] transition-[border-color,background-color] duration-150 hover:bg-panel-2 [&.on]:border-accent';
// a slider: a slim track, the part up to the thumb in the accent, a thumb with a ring of the page colour around it
const TRACK = 'relative h-1 flex-1 rounded-full bg-line-2';
const THUMB = 'size-4.5 rounded-full border-2 border-bg bg-accent shadow-lift has-focus-visible:outline has-focus-visible:outline-offset-3 has-focus-visible:outline-accent';

type OpacityKey = 'backgroundOpacity' | 'mapDotsOpacity';

// A 0-100% slider for one of the open project's opacities: the Station follows while you drag, and it is
// saved when you let go. Default puts the project back on the look's own value.
function OpacitySlider({ project, field, label, value, hint }: { project: Project; field: OpacityKey; label: string; value: number; hint: string }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  // (the Station reads the open project each frame)
  const live = (n: number | undefined) => {
    const p = state.data?.project;
    if (p?.id !== project.id) return;
    if (n === undefined) delete p[field];
    else p[field] = n;
  };
  const save = async (n: number | null) => {
    live(n ?? undefined);
    await attempt(() => rpc.projects.change({ id: project.id, [field]: n }));
    setDragging(null);
  };
  return (
    <Row title={label} description={hint}>
      <div className="flex w-72 max-w-full items-center gap-3 max-sm:w-full">
        <Slider.Root
          className="flex-1"
          min={0}
          max={100}
          step={5}
          value={shown}
          format={{ style: 'unit', unit: 'percent', maximumFractionDigits: 0 }}
          onValueChange={(v) => {
            const n = Array.isArray(v) ? v[0] : v;
            setDragging(n);
            live(n);
          }}
          onValueCommitted={(v) => void save(Array.isArray(v) ? v[0] : v)}
        >
          <Slider.Control className="flex h-5.5 cursor-pointer touch-none items-center">
            <Slider.Track className={TRACK}>
              <Slider.Indicator className="rounded-full bg-accent" />
              <Slider.Thumb className={THUMB} aria-label={label} />
            </Slider.Track>
          </Slider.Control>
        </Slider.Root>
        <b className="look-opacity min-w-10 text-right text-[13px] leading-[normal] font-medium text-ink tabular-nums">{`${shown}%`}</b>
        {project[field] !== undefined ? (
          <Button type="button" variant="ghost" size="tiny" onClick={() => void save(null)}>
            Default
          </Button>
        ) : null}
      </div>
    </Row>
  );
}

// The open project's picture behind the map: a small preview, buttons to change or remove it, and how strong
// it and the map's dots are.
function StationBackground({ look }: { look: LookSetting['stationLook'] }) {
  const proj = useAppState()?.project;
  if (!proj?.id) return null;
  const url = backgroundUrl(proj);
  const ref = { id: proj.id, name: proj.name };
  return (
    <>
      <Row title="Background" description={`A picture behind the map, for ${proj.name} only. Dimmed in the classic look; in the voxel world it takes the sky's place. You can also ask the Brain to set one.`}>
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          {url ? <img className="look-background h-14 w-24 flex-none rounded-ctl border border-line object-cover" src={url} alt="" /> : null}
          <Button type="button" variant="ghost" size="small" onClick={() => void pickBackground(ref)}>
            <Icon name="image" size={13} />
            {url ? 'Change picture' : 'Add a picture'}
          </Button>
          {url ? (
            <Button type="button" variant="ghost" size="small" onClick={() => void removeBackground(ref)}>
              Remove
            </Button>
          ) : null}
        </div>
      </Row>
      {url ? (
        <OpacitySlider
          project={proj}
          field="backgroundOpacity"
          label="Picture opacity"
          value={backgroundOpacity(proj, look)}
          hint={`How strongly the picture shows. 0% hides it. Unless you pick one, it is ${BACKGROUND_OPACITY.classic}% in the classic look and ${BACKGROUND_OPACITY.world}% in the voxel world.`}
        />
      ) : null}
      <OpacitySlider project={proj} field="mapDotsOpacity" label="Map dots opacity" value={mapDotsOpacity(proj)} hint="The dots on the classic map's floor. 0% hides them." />
    </>
  );
}

export function LookTab() {
  const [look, setLook] = useState<LookSetting>(() => ({ ...DEFAULT_LOOK, ...(state.data?.settings?.look || {}) }));
  // the scale while dragging: shown and applied live, saved when let go
  const [dragging, setDragging] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the change waiting to be saved: leaving the tab saves it now rather than dropping it
  const unsaved = useRef<LookSetting | null>(null);
  // the swatches are drawn in the colours for the page's light or dark: draw them again when it switches
  const [, redraw] = useState(0);
  useEffect(() => onThemeChange(() => redraw((n) => n + 1)), []);
  const save = () => {
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    const next = unsaved.current;
    unsaved.current = null;
    if (!next) return;
    void attempt(() => rpc.settings.save({ look: next })).then((r) => {
      if (r && state.data?.settings) state.data.settings.look = { ...next };
    });
  };
  useEffect(() => save, []);

  const set = (patch: Partial<LookSetting>) => {
    const next = { ...look, ...patch };
    setLook(next);
    setDragging(null);
    applyLook(next);
    unsaved.current = next;
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(save, SAVE_AFTER);
  };
  const scale = dragging ?? look.scale;

  return (
    <div className="flex flex-col gap-10">
      <Section title="Colour scheme" description="Light or dark pages. System follows your computer, and changes when it does.">
        <Row title="Theme" titleId="look-theme">
          <Segmented
            label="Theme"
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            value={look.theme}
            onChange={(v) => set({ theme: v })}
          />
        </Row>
      </Section>

      <Section title="UI scale" description="Makes everything bigger or smaller: text, buttons, panels and the Station. Your browser zoom (Ctrl + / Ctrl −) still works on top of this.">
        <div className="px-5 py-5">
          <div className="flex items-center gap-3.5">
            <span className="text-[12px] text-faint" aria-hidden="true">A</span>
            <Slider.Root
              className="flex-1"
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
              <Slider.Control className="flex h-5.5 cursor-pointer touch-none items-center">
                <Slider.Track className={TRACK}>
                  <Slider.Indicator className="rounded-full bg-accent" />
                  <Slider.Thumb className={THUMB} aria-label="UI scale" />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>
            <span className="text-[20px] text-faint" aria-hidden="true">A</span>
            <b className="look-pct min-w-13 text-right text-[15px] leading-[normal] font-semibold text-ink tabular-nums">{`${scale}%`}</b>
          </div>
          <div className="look-presets mt-4 flex flex-wrap items-center gap-2">
            {SCALES.map((v) => (
              <Button key={v} size="tiny" variant={look.scale === v ? 'primary' : 'ghost'} aria-pressed={look.scale === v} onClick={() => set({ scale: v })}>
                {v === 100 ? '100% (default)' : `${v}%`}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Accent colour" titleId="look-accent" description="The highlight colour for buttons, active tabs, the status dots and focus rings.">
        <div className="px-5 py-5">
          <RadioGroup className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3" aria-labelledby="look-accent" value={accentFor(look.accent).id} onValueChange={(v) => set({ accent: v as LookSetting['accent'] })}>
            {ACCENTS.map((a) => (
              <Radio.Root
                key={a.id}
                value={a.id}
                nativeButton
                render={<button type="button" />}
                className={(s) => (s.checked ? `${SWATCH} on` : SWATCH)}
                style={{ '--sw': accentTone(a).c } as CSSProperties}
                title={a.label}
              >
                <span className="size-5 flex-none rounded-full bg-(--sw)" aria-hidden="true" />
                <span>{a.label}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
        </div>
      </Section>

      <Section title="Animations" description="Panels sliding in and pulses. Reduced keeps the Station moving but turns off most interface motion.">
        <Row title="Motion" titleId="look-motion">
          <Segmented
            label="Motion"
            options={[
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
            ]}
            value={look.motion}
            onChange={(v) => set({ motion: v })}
          />
        </Row>
      </Section>

      <Section title="Chat font" titleId="look-chat-font" description="What the messages in chats are written in: yours, your agents’ and the Brain’s. Names, buttons and code keep their own fonts.">
        <div className="px-5 py-5">
          <RadioGroup className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-3" aria-labelledby="look-chat-font" value={look.chatFont} onValueChange={(v) => set({ chatFont: String(v) })}>
            {CHAT_FONTS.map((f) => (
              <Radio.Root key={f.id} value={f.id} nativeButton render={<button type="button" />} className={(s) => (s.checked ? `${FONT} on` : FONT)}>
                <span className="text-[15px] leading-[1.4]" style={{ fontFamily: f.stack }}>{f.label}</span>
                <span className="text-[12.5px] leading-[1.4] text-dim">{f.like}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
        </div>
      </Section>

      <Section title="Station look" description="Voxel world lights the Station like the world your agents will build: a sky, a sun with soft shadows, glow around bright things and a miniature blur at the edges. Classic is the flat map.">
        <Row title="Look" titleId="look-station-look">
          <Segmented
            label="Station look"
            options={[
              { value: 'classic', label: 'Classic' },
              { value: 'world', label: 'Voxel world' },
            ]}
            value={look.stationLook}
            onChange={(v) => set({ stationLook: v })}
          />
        </Row>
        {look.stationLook === 'world' ? (
          <Row title="Quality" description="Low has no shadows or glow, for older computers. High adds softer creases and smoother edges.">
            <Segmented
              label="Voxel world quality"
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]}
              value={look.worldQuality}
              onChange={(v) => set({ worldQuality: v })}
            />
          </Row>
        ) : null}
        <StationBackground look={look.stationLook} />
      </Section>

      <Section title="Station quality" description="How hard the 3D map works. Lower it if your fans spin up, your battery drains or the map stutters with many agents.">
        <Row title="Quality" titleId="look-station" description={<span className="look-station-hint">{stationLevel(look.station).hint}</span>}>
          <Segmented label="Station quality" options={STATION_QUALITY.map((q) => ({ value: q.id, label: q.label }))} value={look.station} onChange={(v) => set({ station: v })} />
        </Row>
      </Section>

      <Section title="Sidebar" description="What the bottom of the menu shows: what’s set up, or how much of your Claude and Codex plans you’ve used, with Codex’s free limit resets. The Status / Limits switch there does the same.">
        <Row title="Shows" titleId="look-sidebar">
          <Segmented
            label="Sidebar shows"
            options={[
              { value: 'status', label: 'Status' },
              { value: 'limits', label: 'Usage limits' },
            ]}
            value={state.data?.project?.sidebar || look.sidebar}
            onChange={(v) => {
              // the menu reads it from here, so it switches now rather than after the save
              if (state.data?.settings) state.data.settings.look = { ...state.data.settings.look, sidebar: v };
              // the open project remembers it too, or its own last choice would win over this
              rememberSidebarPanel(v);
              set({ sidebar: v });
            }}
          />
        </Row>
      </Section>

      <Section title="Preview" description="How the buttons, labels and chat text look with these choices.">
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <Button size="small">Button</Button>
            <Button variant="ghost" size="small">Ghost</Button>
            <Pill tone="ok">ready</Pill>
            <span className="inline-flex items-center gap-2 text-[13px] text-dim">
              <Dot tone="on" /> running
            </span>
          </div>
          <p className="look-sample m-0 rounded-box border border-line bg-panel-2 px-4 py-3 font-chat text-[14px] leading-[1.6]">
            Done. I read the three reports and put a one-page summary in <code>notes/summary.md</code>.
          </p>
        </div>
        <div className="flex items-center justify-end px-5 py-3.5">
          <Button variant="ghost" size="small" onClick={() => set({ ...DEFAULT_LOOK })}>Reset to default</Button>
        </div>
      </Section>
    </div>
  );
}

export const title = () => 'Appearance';
export const { render, unmount } = reactPage(() => <LookTab />);
