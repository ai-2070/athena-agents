// A small skill picker: the skills given here as chips (✕ to remove) and "+ Add skill" with the library.
// Used for an agent, a team and the project.
import { h, mount, GET, navigate } from './core.js';
import { icon } from './icons.js';
import { uiZoom } from './look.js';

let cache = null;
let loading = null;
export async function loadSkills(force = false) {
  if (cache && !force) return cache;
  loading ||= GET('/skills')
    .then((r) => (cache = r.skills))
    .catch(() => (cache = []))
    .finally(() => (loading = null));
  return loading;
}
export const skillsCache = () => cache || [];
export const forgetSkills = () => (cache = null);

// current: slugs. onChange(slugs) saves. inherited: [{ slug, from: 'project' | 'team name' }] shown greyed.
export function skillPicker(current, onChange, { inherited = [], empty = 'No skills yet.' } = {}) {
  const box = h('div.skp');
  let list = [...(current || [])];
  const draw = () => {
    const lib = skillsCache();
    const by = new Map(lib.map((s) => [s.slug, s]));
    const add = h('button.skp-add', { type: 'button', onclick: (e) => openMenu(e.currentTarget) }, icon('plus', 13), 'Add skill');
    mount(
      box,
      h(
        'div.skp-chips',
        list.map((slug) =>
          h(
            'span.skp-chip',
            { title: by.get(slug)?.description || slug },
            icon('puzzle', 12),
            by.get(slug)?.name || slug,
            h('button', { type: 'button', title: 'Remove', onclick: () => ((list = list.filter((x) => x !== slug)), onChange(list), draw()) }, '✕'),
          ),
        ),
        inherited
          .filter((x) => !list.includes(x.slug))
          .map((x) => h('span.skp-chip.inherited', { title: `${by.get(x.slug)?.description || ''}\nComes from ${x.from}` }, icon('puzzle', 12), by.get(x.slug)?.name || x.slug, h('span.skp-from', x.from))),
        add,
      ),
      !list.length && !inherited.length ? h('div.hint', empty) : null,
    );
  };
  const openMenu = (anchor) => {
    document.querySelector('.skp-menu')?.remove();
    const lib = skillsCache().filter((s) => !list.includes(s.slug));
    const r = anchor.getBoundingClientRect();
    const z = uiZoom();
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (e) => !menu.contains(e.target) && close();
    const search = h('input.model-search', { placeholder: 'Search skills…' });
    const items = h('div.model-list');
    const fill = () => {
      const q = search.value.toLowerCase();
      const shown = lib.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)).slice(0, 40);
      mount(
        items,
        shown.length
          ? shown.map((s) => h('button.st-menu-item', { onclick: () => (close(), (list = [...list, s.slug]), onChange(list), draw()) }, icon('puzzle', 14), h('span.grow', s.name, h('span.model-sub', s.description.slice(0, 90)))))
          : h('div.hint', { style: { padding: '8px 10px' } }, lib.length ? 'No match.' : 'No more skills in the library.'),
      );
    };
    search.addEventListener('input', fill);
    const menu = h('div.st-menu.skp-menu', h('div.st-menu-head', 'Add a skill'), search, items, h('div.st-menu-sep'), h('button.st-menu-item', { onclick: () => (close(), navigate('#/skills')) }, icon('plus', 14), 'Make or import a skill…'));
    document.body.append(menu);
    fill();
    Object.assign(menu.style, { position: 'fixed', left: `${Math.min(r.left / z, window.innerWidth / z - 340)}px`, top: `${Math.min(r.bottom / z + 6, window.innerHeight / z - 380)}px`, transform: 'none', zIndex: 96, width: '320px' });
    setTimeout(() => (document.addEventListener('pointerdown', outside, true), search.focus()), 0);
  };
  draw();
  loadSkills().then(draw);
  return box;
}
