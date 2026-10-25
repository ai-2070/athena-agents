// Settings > Look: UI scale, accent colour, animations. Changes apply right away.
import { h, mount, PUT, attempt, state, field, seg } from '../core.ts';
import { ACCENTS, DEFAULT_LOOK, applyLook } from '../look.ts';
import type { LookSetting } from '../../shared/types.ts';

export const title = () => 'Look';

export async function render(el: HTMLElement): Promise<void> {
  const look: LookSetting = { ...DEFAULT_LOOK, ...(state.data?.settings?.look || {}) };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    clearTimeout(saveTimer ?? undefined);
    saveTimer = setTimeout(async () => {
      const r = await attempt(() => PUT('/settings', { look }));
      if (r && state.data?.settings) state.data.settings.look = { ...look };
    }, 350);
  };
  const set = (patch: Partial<LookSetting>) => {
    Object.assign(look, patch);
    applyLook(look);
    save();
    draw();
  };

  const draw = () => {
    const pct = h('b.look-pct', `${look.scale}%`);
    const slider = h('input.look-range', { type: 'range', min: 70, max: 160, step: 5, value: look.scale, 'aria-label': 'UI scale' });
    // live while dragging, saved when let go
    slider.addEventListener('input', () => {
      pct.textContent = `${slider.value}%`;
      applyLook({ ...look, scale: Number(slider.value) });
    });
    slider.addEventListener('change', () => set({ scale: Number(slider.value) }));
    mount(
      el,
      h(
        'div.two-col',
        h(
          'div.col',
          h(
            'div.panel',
            h('div.panel-head', h('h2', 'UI scale')),
            h('p.hint', 'Makes everything bigger or smaller: text, buttons, panels and the Station. Your browser zoom (Ctrl + / Ctrl −) still works on top of this.'),
            h('div.look-scale.mt', h('span.hint', 'A'), slider, h('span.look-big', 'A'), pct),
            h(
              'div.row.mt',
              { style: { gap: '6px', flexWrap: 'wrap' } },
              [80, 90, 100, 110, 125, 150].map((v) => h(`button.btn.tiny${look.scale === v ? '' : '.ghost'}`, { onclick: () => set({ scale: v }) }, v === 100 ? '100% (default)' : `${v}%`)),
            ),
          ),
          h(
            'div.panel',
            h('div.panel-head', h('h2', 'Animations')),
            h('p.hint', 'Panels sliding in, glows and pulses. Reduced keeps the Station moving but turns off most interface motion.'),
            h('div.mt', field('Motion', seg([{ value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }], look.motion, (v) => set({ motion: v })))),
          ),
        ),
        h(
          'div.col',
          h(
            'div.panel',
            h('div.panel-head', h('h2', 'Accent colour')),
            h('p.hint', 'The highlight colour for buttons, active tabs, the status dots and focus rings.'),
            h(
              'div.look-swatches.mt',
              ACCENTS.map((a) =>
                h(
                  `button.look-swatch${look.accent === a.id ? '.on' : ''}`,
                  { type: 'button', style: { '--sw': a.c }, onclick: () => set({ accent: a.id }), title: a.label },
                  h('span.look-dot'),
                  h('span', a.label),
                ),
              ),
            ),
          ),
          h(
            'div.panel',
            h('div.panel-head', h('h2', 'Preview')),
            h('div.row', { style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, h('button.btn.small', 'Button'), h('button.btn.ghost.small', 'Ghost'), h('span.pill.ok', 'ready'), h('span', h('span.dot.on'), ' running')),
            h('div.row.mt', h('button.btn.ghost.small', { onclick: () => set({ ...DEFAULT_LOOK }) }, 'Reset to default')),
          ),
        ),
      ),
    );
  };
  draw();
}
