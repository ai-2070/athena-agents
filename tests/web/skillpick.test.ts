// The skill picker's menu: pick from the library, or make / import one without leaving the place you are.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { forgetSkills, loadSkills } from '../../web/skillcache.ts';
import { skillPicker } from '../../web/skillpick.ts';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = () => act(() => new Promise((r) => setTimeout(r, 30)));
let skills: { slug: string; name: string; description: string }[];

beforeEach(async () => {
  Element.prototype.getAnimations ??= () => [];
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>';
  state.data = { agents: [], project: { id: 'p', name: 'P', skills: [] } } as unknown as AppState;
  skills = [
    { slug: 'house-style', name: 'House style', description: 'How we write.' },
    { slug: 'seo', name: 'SEO', description: 'Search basics.' },
  ];
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).includes('/skills') ? { skills, claude: [] } : { ok: true })));
  forgetSkills();
  await loadSkills(true);
});
afterEach(() => {
  document.documentElement.classList.remove('reduce-motion');
  document.querySelectorAll('.skp-menu').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

const open = async (saved: string[][]) => {
  const picker = skillPicker([], (v) => saved.push(v));
  document.body.append(picker);
  await tick();
  await act(async () => picker.querySelector<HTMLButtonElement>('button')!.click());
  await tick();
  return picker;
};

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await tick();
};


describe('skillPicker() menu', () => {
  it('lists the library with each description, filters as you type, and adds what you pick', async () => {
    const saved: string[][] = [];
    const picker = await open(saved);
    const menu = document.querySelector('.skp-menu')!;
    expect([...menu.querySelectorAll('.st-menu-item')].map((b) => b.textContent)).toEqual(['House styleHow we write.', 'SEOSearch basics.']);
    const search = menu.querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(search);
    await act(async () => {
      search.value = 'seo';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...menu.querySelectorAll('.st-menu-item')].map((b) => b.textContent)).toEqual(['SEOSearch basics.']);
    await click(menu.querySelector<HTMLButtonElement>('.st-menu-item')!);
    expect(saved).toEqual([['seo']]);
    expect(picker.textContent).toContain('SEO');
    expect(document.querySelector('.skp-menu')).toBeNull();
  });

  it('closes on Escape and returns focus to Add skill', async () => {
    const saved: string[][] = [];
    const picker = await open(saved);
    const trigger = picker.querySelector<HTMLButtonElement>('button')!;
    const search = document.querySelector<HTMLInputElement>('.skp-menu input')!;
    expect(document.activeElement).toBe(search);
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await tick();
    expect(document.querySelector('.skp-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(saved).toEqual([]);
  });

  it('closes on an outside click without changing the selection', async () => {
    const saved: string[][] = [];
    await open(saved);
    expect(document.querySelector('.skp-menu')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await tick();
    expect(document.querySelector('.skp-menu')).toBeNull();
    expect(saved).toEqual([]);
  });

  it('closes after a selection when motion is reduced', async () => {
    document.documentElement.classList.add('reduce-motion');
    const saved: string[][] = [];
    await open(saved);
    await click(document.querySelector<HTMLButtonElement>('.skp-menu .st-menu-item')!);
    expect(saved).toEqual([['house-style']]);
    expect(document.querySelector('.skp-menu')).toBeNull();
  });

  it('New opens the skill editor right here, and a skill made there is added too', async () => {
    const saved: string[][] = [];
    const picker = await open(saved);
    await click([...document.querySelectorAll<HTMLButtonElement>('.skp-menu button')].find((b) => b.textContent?.trim() === 'New')!);
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

  it.each([
    ['From GitHub', 'Install skills from GitHub'],
    ['From Claude Code', 'Import from Claude Code'],
  ])('%s opens its import dialog', async (label, title) => {
    const saved: string[][] = [];
    await open(saved);
    await click([...document.querySelectorAll<HTMLButtonElement>('.skp-menu button')].find((b) => b.textContent?.trim() === label)!);
    await tick();
    expect(document.querySelector('.modal h2')?.textContent).toBe(title);
    expect(document.querySelector('.skp-menu')).toBeNull();
    expect(saved).toEqual([]);
  });
});
