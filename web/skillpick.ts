// A small skill picker: the skills given here as chips (✕ to remove) and "+ Add skill" with the library.
// Used for an agent, a team and the project.
import { h, mount, GET } from './core.ts';
import { icon } from './icons.ts';
import { uiZoom } from './look.ts';
import { dismissMenu } from './menuclose.ts';
import { openEditor, openGitHub, openImport } from './skilldialogs.ts';
import type { ClaudeSkill, SkillListing } from '../shared/types.ts';

/** A skill another level gives (the project, a team), shown greyed. */
export interface InheritedSkill {
  slug: string;
  from: string;
}

let cache: SkillListing[] | null = null;
let loading: Promise<SkillListing[]> | null = null;
export async function loadSkills(force = false): Promise<SkillListing[]> {
  if (cache && !force) return cache;
  loading ||= GET<{ skills: SkillListing[]; claude: ClaudeSkill[] }>('/skills')
    .then((r): SkillListing[] => (cache = r.skills))
    // not cached, so the next load tries again
    .catch((): SkillListing[] => [])
    .finally(() => (loading = null));
  return loading;
}
export const skillsCache = (): SkillListing[] => cache || [];
export const forgetSkills = (): null => (cache = null);
let closeSkillMenu: (() => void) | null = null;

// current: slugs. onChange(slugs) saves. inherited: [{ slug, from: 'project' | 'team name' }] shown greyed.
export function skillPicker(current: readonly string[] | null | undefined, onChange: (slugs: string[]) => void, { inherited = [], empty = 'No skills yet.' }: { inherited?: InheritedSkill[]; empty?: string } = {}): HTMLDivElement {
  const box = h('div');
  let list = [...(current || [])];
  const draw = () => {
    const lib = skillsCache();
    const by = new Map(lib.map((s) => [s.slug, s]));
    const add = h('button', { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 px-3 border border-dashed border-line-2 rounded-full text-dim cursor-pointer text-[12.5px] hover:text-ink hover:bg-ink/5', type: 'button', onclick: (e) => openMenu(e.currentTarget) }, icon('plus', 13), 'Add skill');
    mount(
      box,
      h(
        'div',
        { class: 'flex flex-wrap gap-2 items-center' },
        list.map((slug) =>
          h(
            'span',
            { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 pr-1.5 pl-2.25 border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-line))] rounded-full bg-accent/9 text-[12.5px] text-ink', title: by.get(slug)?.description || slug },
            icon('puzzle', 12),
            by.get(slug)?.name || slug,
            h('button', { class: 'text-dim cursor-pointer text-[10px] px-0.75 hover:text-ink', type: 'button', title: 'Remove', onclick: () => ((list = list.filter((x) => x !== slug)), onChange(list), draw()) }, '✕'),
          ),
        ),
        inherited
          .filter((x) => !list.includes(x.slug))
          .map((x) => h('span', { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 px-2.25 border border-dashed border-line-2 rounded-full text-[12.5px] text-dim', title: `${by.get(x.slug)?.description || ''}\nComes from ${x.from}` }, icon('puzzle', 12), by.get(x.slug)?.name || x.slug, h('span', { class: 'text-[11.5px] text-faint' }, x.from))),
        add,
      ),
      !list.length && !inherited.length ? h('div.hint', { class: 'mt-2' }, empty) : null,
    );
  };
  const openMenu = (anchor: Element) => {
    closeSkillMenu?.();
    document.querySelectorAll('.skp-picker-menu').forEach((old) => old.remove());
    const lib = skillsCache().filter((s) => !list.includes(s.slug));
    const r = anchor.getBoundingClientRect();
    const z = uiZoom();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (closeSkillMenu === close) closeSkillMenu = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      dismissMenu(menu);
    };
    closeSkillMenu = close;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      if (anchor instanceof HTMLElement) anchor.focus();
    };
    const outside = (e: PointerEvent) => !menu.contains(e.target as Node | null) && close();
    const search = h('input', { class: 'w-full py-2 pr-2.5 pl-8 text-[13.5px]', placeholder: 'Search skills…', 'aria-label': 'Search skills' });
    const items = h('div', { class: 'flex max-h-64 flex-col gap-0.5 overflow-y-auto' });
    const fill = () => {
      const q = search.value.toLowerCase();
      const shown = lib.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)).slice(0, 40);
      mount(
        items,
        shown.length
          ? shown.map((s) =>
              h(
                'button.st-menu-item',
                { class: 'shrink-0 gap-3 py-2', type: 'button', title: s.description, onclick: () => (close(), (list = [...list, s.slug]), onChange(list), draw()) },
                h('span', { class: 'grid size-7 flex-none place-items-center rounded-[8px] bg-accent/10 text-accent' }, icon('puzzle', 14)),
                h('span', { class: 'min-w-0 flex-1' }, h('span', { class: 'block truncate text-[13px] leading-tight font-medium' }, s.name), h('span', { class: 'mt-0.5 block truncate text-[11.5px] leading-tight font-normal text-faint' }, s.description)),
              ),
            )
          : h('div.hint', { class: 'px-2.5 py-2' }, lib.length ? 'No match.' : 'No more skills in the library.'),
      );
    };
    search.addEventListener('input', fill);
    // Making or importing opens the same dialogs as the Skills page, right here. What they add is given to this one too.
    const known = new Set(skillsCache().map((s) => s.slug));
    const afterMake = async () => {
      await loadSkills(true);
      const fresh = skillsCache().filter((s) => !known.has(s.slug));
      for (const f of fresh) known.add(f.slug);
      if (fresh.length) (list = [...list, ...fresh.map((f) => f.slug)]), onChange(list);
      draw();
    };
    const action = (label: string, ico: string, run: () => unknown) => h('button.btn.ghost.tiny', { class: 'flex-1 justify-center', type: 'button', onclick: () => (close(), void run()) }, icon(ico, 12), label);
    // The picker marker keeps an earlier closing popup from covering a newly opened one.
    const menu = h(
      'div.st-menu.skp-menu.skp-picker-menu',
      { class: 'max-w-none' },
      h('div.st-menu-head', 'Add a skill'),
      h('div', { class: 'relative mb-1.5 px-0.5' }, icon('search', 14, 'pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint'), search),
      items,
      h('div.st-menu-sep'),
      h(
        'div',
        { class: 'flex gap-2' },
        action('New', 'plus', () => openEditor(null, afterMake)),
        action('From GitHub', 'download', () => openGitHub(afterMake)),
        action('From Claude Code', 'terminal', async () => openImport((await GET<{ claude: ClaudeSkill[] }>('/skills')).claude, afterMake)),
      ),
    );
    document.body.append(menu);
    fill();
    Object.assign(menu.style, { position: 'fixed', left: `${Math.min(r.left / z, window.innerWidth / z - 360)}px`, top: `${Math.min(r.bottom / z + 6, window.innerHeight / z - 420)}px`, transform: 'none', zIndex: 96, width: '340px' });
    setTimeout(() => {
      if (closed) return;
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', escape, true);
      search.focus();
    }, 0);
  };
  draw();
  loadSkills().then(draw);
  return box;
}
