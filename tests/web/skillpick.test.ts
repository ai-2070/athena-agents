// The skill picker's menu: pick from the library, or make / import one without leaving the place you are.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { forgetSkills, loadSkills, skillPicker } from '../../web/skillpick.ts';
import type { AppState } from '../../shared/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
let skills: { slug: string; name: string; description: string }[];

beforeEach(async () => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>';
  state.data = { agents: [], project: { id: 'p', name: 'P', skills: [] } } as unknown as AppState;
  skills = [
    { slug: 'house-style', name: 'House style', description: 'How we write.' },
    { slug: 'seo', name: 'SEO', description: 'Search basics.' },
  ];
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).includes('/skills') ? { skills, claude: [] } : { ok: true })));
  forgetSkills();
  await loadSkills(true);
});
afterEach(() => {
  document.querySelectorAll('.skp-menu').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

const open = (saved: string[][]) => {
  const picker = skillPicker([], (v) => saved.push(v));
  document.body.append(picker);
  picker.querySelector<HTMLButtonElement>('button')!.click();
  return picker;
};

describe('skillPicker() menu', () => {
  it('lists the library with each description, filters as you type, and adds what you pick', async () => {
    const saved: string[][] = [];
    open(saved);
    const menu = document.querySelector('.skp-menu')!;
    expect([...menu.querySelectorAll('.st-menu-item')].map((b) => b.textContent)).toEqual(['House styleHow we write.', 'SEOSearch basics.']);
    const search = menu.querySelector<HTMLInputElement>('input')!;
    search.value = 'seo';
    search.dispatchEvent(new Event('input'));
    expect(menu.querySelectorAll('.st-menu-item')).toHaveLength(1);
    menu.querySelector<HTMLButtonElement>('.st-menu-item')!.click();
    expect(saved).toEqual([['seo']]);
    expect(document.querySelector('.skp-menu')).toBeNull();
  });

  it('New opens the skill editor right here, and a skill made there is added too', async () => {
    const saved: string[][] = [];
    const picker = open(saved);
    [...document.querySelectorAll<HTMLButtonElement>('.skp-menu button')].find((b) => b.textContent?.trim() === 'New')!.click();
    await tick();
    await tick();
    expect(document.querySelector('.modal h2')!.textContent).toBe('New skill');
    // the editor saved one: the library now has a third skill
    skills.push({ slug: 'new-one', name: 'New one', description: 'Fresh.' });
    const name = document.querySelector<HTMLInputElement>('.modal label.field input')!;
    name.value = 'New one';
    const [desc, body] = document.querySelectorAll<HTMLTextAreaElement>('.modal label.field textarea');
    desc.value = 'Fresh.';
    body.value = 'Steps.';
    [...document.querySelectorAll<HTMLButtonElement>('.modal-foot button')].find((b) => b.textContent === 'Add skill')!.click();
    await tick();
    await tick();
    await tick();
    expect(saved.at(-1)).toEqual(['new-one']);
    expect(picker.textContent).toContain('New one');
  });
});
