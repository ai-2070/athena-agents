// A small skill picker: the skills given here as chips (✕ to remove) and "+ Add skill" with the library.
// Used for an agent, a team and the project.
import { h, mount } from './core.ts';
import { rpc } from './client/rpc.ts';
import { icon } from './icons.ts';
import { loadSkills, skillsCache } from './skillcache.ts';
import { skillIcon } from './skillicons.ts';
import { openEditor, openGitHub, openImport } from './skilldialogs.tsx';
import { openSkillPickerMenu } from './skillpickmenu.tsx';

/** A skill another level gives (the project, a team), shown greyed. */
export interface InheritedSkill {
  slug: string;
  from: string;
}

let closeSkillMenu: (() => void) | null = null;

// current: slugs. onChange(slugs) saves. inherited: [{ slug, from: 'project' | 'team name' }] shown greyed.
export function skillPicker(current: readonly string[] | null | undefined, onChange: (slugs: string[]) => void, { inherited = [], empty = 'No skills yet.' }: { inherited?: InheritedSkill[]; empty?: string } = {}): HTMLDivElement {
  const box = h('div');
  let list = [...(current || [])];
  const add = h('button', { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 px-3 border border-dashed border-line-2 rounded-full text-dim cursor-pointer text-[12.5px] hover:text-ink hover:bg-ink/5', type: 'button', onclick: (e) => openMenu(e.currentTarget) }, icon('plus', 13), 'Add skill');
  const draw = () => {
    const lib = skillsCache();
    const by = new Map(lib.map((s) => [s.slug, s]));
    mount(
      box,
      h(
        'div',
        { class: 'flex flex-wrap gap-2 items-center' },
        list.map((slug) =>
          h(
            'span',
            { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 pr-1.5 pl-2.25 border border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-line))] rounded-full bg-accent/9 text-[12.5px] text-ink', title: by.get(slug)?.description || slug },
            skillIcon(slug, 13),
            by.get(slug)?.name || slug,
            h('button', { class: 'text-dim cursor-pointer text-[10px] px-0.75 hover:text-ink', type: 'button', title: 'Remove', onclick: () => ((list = list.filter((x) => x !== slug)), onChange(list), draw()) }, '✕'),
          ),
        ),
        inherited
          .filter((x) => !list.includes(x.slug))
          .map((x) => h('span', { class: 'pill-shadow inline-flex items-center gap-1.5 py-1 px-2.25 border border-dashed border-line-2 rounded-full text-[12.5px] text-dim', title: `${by.get(x.slug)?.description || ''}\nComes from ${x.from}` }, skillIcon(x.slug, 13), by.get(x.slug)?.name || x.slug, h('span', { class: 'text-[11.5px] text-faint' }, x.from))),
        add,
      ),
      !list.length && !inherited.length ? h('div.hint', { class: 'mt-2' }, empty) : null,
    );
  };
  const openMenu = (anchor: HTMLElement) => {
    closeSkillMenu?.();
    const known = new Set(skillsCache().map((s) => s.slug));
    const afterMake = async () => {
      await loadSkills(true);
      const fresh = skillsCache().filter((s) => !known.has(s.slug));
      for (const f of fresh) known.add(f.slug);
      if (fresh.length) (list = [...list, ...fresh.map((f) => f.slug)]), onChange(list);
      draw();
    };
    closeSkillMenu = openSkillPickerMenu({
      anchor,
      skills: skillsCache().filter((s) => !list.includes(s.slug)),
      select: (slug) => { list = [...list, slug]; onChange(list); draw(); },
      make: () => openEditor(null, afterMake),
      github: () => openGitHub(afterMake),
      importClaude: () => { void rpc.skills.list().then((result) => openImport(result.claude, afterMake)); },
    });
  };
  draw();
  loadSkills().then(draw);
  return box;
}
