// Settings > Appearance: the chat font (picking one changes --font-chat and saves it) and the Station quality.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import {
  CHAT_FONTS,
  DEFAULT_LOOK,
  STATION_QUALITY,
  applyLook,
  chatFont,
  currentLook,
  stationLevel,
} from '../../web/look.ts';
import { LookTab } from '../../web/views/look.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fontVar = () => document.documentElement.style.getPropertyValue('--font-chat');

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  // (a test that picks light or dark leaves it on <html>; the next one starts from the system's own setting)
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

describe('chat fonts', () => {
  it('the default keeps the stylesheet’s own font', () => {
    applyLook({ chatFont: 'sans' });
    expect(fontVar()).toBe('');
  });

  it('a picked font sets --font-chat', () => {
    applyLook({ chatFont: 'google' });
    expect(fontVar()).toContain("'Google Sans'");
    applyLook({ chatFont: 'mono' });
    expect(fontVar()).toContain('JetBrains Mono');
    // back to the default
    applyLook({ chatFont: 'sans' });
    expect(fontVar()).toBe('');
  });

  it('an unknown or missing font falls back to the default', () => {
    expect(chatFont('nope').id).toBe(DEFAULT_LOOK.chatFont);
    expect(chatFont(undefined).id).toBe(DEFAULT_LOOK.chatFont);
    applyLook({ chatFont: 'nope' });
    expect(fontVar()).toBe('');
  });
});

describe('Station quality', () => {
  it('fewer frames and pixels the lower it is, Balanced by default', () => {
    expect(DEFAULT_LOOK.station).toBe('balanced');
    expect(stationLevel(undefined).id).toBe('balanced');
    expect(stationLevel('nope').id).toBe('balanced');
    const [smooth, balanced, saver] = ['smooth', 'balanced', 'saver'].map(stationLevel);
    expect(smooth.fps.moving).toBeNull(); // as fast as the screen
    expect(balanced.fps.moving!).toBeGreaterThan(saver.fps.moving!);
    for (const q of STATION_QUALITY) expect(q.fps.still).toBeGreaterThan(q.fps.away);
    expect(smooth.pixelRatio).toBeGreaterThan(balanced.pixelRatio);
    expect(balanced.pixelRatio).toBeGreaterThan(saver.pixelRatio);
    // a desk's screen has to look bigger before Battery saver animates it
    expect(saver.screenPx).toBeGreaterThan(balanced.screenPx);
  });

  it('the map reads the quality in use from the look', () => {
    applyLook({ station: 'saver' });
    expect(currentLook().station).toBe('saver');
    applyLook({});
    expect(currentLook().station).toBe('balanced');
  });
});

describe('Settings > Appearance', () => {
  let el: HTMLElement;
  let root: Root;
  const puts: unknown[] = [];
  beforeEach(() => {
    puts.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
      }),
    );
    document.body.innerHTML = '<div id="toasts"></div><section id="view"></section>';
    el = document.getElementById('view')!;
    state.data = { settings: { look: { ...DEFAULT_LOOK } } } as unknown as AppState;
    root = createRoot(el);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    state.data = null;
  });

  it('lists every chat font in its own font, and saves the one picked', async () => {
    await act(async () => root.render(<LookTab />));
    const choices = [...el.querySelectorAll<HTMLButtonElement>('.look-font')];
    expect(choices.map((c) => c.firstElementChild!.textContent)).toEqual(CHAT_FONTS.map((f) => f.label));
    expect(choices.map((c) => c.getAttribute('aria-checked'))).toEqual(CHAT_FONTS.map((f) => String(f.id === 'sans')));
    const unquoted = (v: string) => v.replace(/["']/g, '');
    expect(choices.map((c) => unquoted((c.firstElementChild as HTMLElement).style.fontFamily))).toEqual(
      CHAT_FONTS.map((f) => unquoted(f.stack)),
    );
    expect(el.querySelector('.look-sample')!.className).toContain('font-chat');

    const roboto = choices[CHAT_FONTS.findIndex((f) => f.id === 'roboto')];
    await act(async () => roboto.click());
    expect(roboto.getAttribute('aria-checked')).toBe('true');
    expect(fontVar()).toContain("'Roboto'");
    await act(async () => vi.advanceTimersByTime(400));
    expect(puts).toEqual([{ look: { ...DEFAULT_LOOK, chatFont: 'roboto' } }]);
  });

  it('picks light, dark or the computer’s own setting, and saves it', async () => {
    await act(async () => root.render(<LookTab />));
    const seg = el.querySelector<HTMLElement>('[aria-label="Theme"]')!;
    const choices = [...seg.querySelectorAll<HTMLButtonElement>('button')];
    expect(choices.map((b) => b.textContent)).toEqual(['System', 'Light', 'Dark']);
    const picked = () => choices.filter((b) => b.classList.contains('on')).map((b) => b.textContent);
    expect(picked()).toEqual(['System']);
    // nothing on <html> while System is picked: the stylesheet follows the computer
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await act(async () => choices[2].click());
    expect(picked()).toEqual(['Dark']);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(currentLook().theme).toBe('dark');
    await act(async () => vi.advanceTimersByTime(400));
    expect(puts).toEqual([{ look: { ...DEFAULT_LOOK, theme: 'dark' } }]);

    await act(async () => choices[1].click());
    expect(document.documentElement.dataset.theme).toBe('light');
    await act(async () => choices[0].click());
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('sets the Station quality, says what it does, and saves it', async () => {
    await act(async () => root.render(<LookTab />));
    const seg = el.querySelector<HTMLElement>('[aria-label="Station quality"]')!;
    const choices = [...seg.querySelectorAll<HTMLButtonElement>('button')];
    expect(choices.map((b) => b.textContent)).toEqual(['Smooth', 'Balanced', 'Battery saver']);
    expect(el.querySelector('.look-station-hint')!.textContent).toBe(stationLevel('balanced').hint);
    await act(async () => choices[2].click());
    expect(el.querySelector('.look-station-hint')!.textContent).toBe(stationLevel('saver').hint);
    expect(currentLook().station).toBe('saver');
    await act(async () => vi.advanceTimersByTime(400));
    expect(puts).toEqual([{ look: { ...DEFAULT_LOOK, station: 'saver' } }]);
  });

  it("shows the open project's background picture, and removes it", async () => {
    state.data = {
      settings: { look: { ...DEFAULT_LOOK } },
      project: { id: 'p1', name: 'Launch', brainPath: '', repo: '', createdAt: 0, backgroundAt: 42 },
    } as unknown as AppState;
    await act(async () => root.render(<LookTab />));
    const img = el.querySelector<HTMLImageElement>('.look-background')!;
    expect(img.getAttribute('src')).toContain('/projects/p1/background');
    expect(el.textContent).toContain('for Launch only');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.some((b) => b.textContent?.includes('Change picture'))).toBe(true);
    await act(async () => buttons.find((b) => b.textContent === 'Remove')!.click());
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    expect(
      calls.some(([url, init]) => String(url).includes('/projects/p1/background') && init?.method === 'DELETE'),
    ).toBe(true);
  });

  it("slides the picture's and the map dots' opacity for the open project, and puts one back to the default", async () => {
    state.data = {
      settings: { look: { ...DEFAULT_LOOK } },
      project: {
        id: 'p1',
        name: 'Launch',
        brainPath: '',
        repo: '',
        createdAt: 0,
        backgroundAt: 42,
        mapDotsOpacity: 40,
      },
    } as unknown as AppState;
    await act(async () => root.render(<LookTab />));
    const pct = () => [...el.querySelectorAll('.look-opacity')].map((b) => b.textContent);
    // the picture's default in the classic look, and the project's own dots
    expect(pct()).toEqual(['50%', '40%']);
    expect(el.textContent).toContain('Picture opacity');
    expect(el.textContent).toContain('Map dots opacity');
    const reset = [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'Default');
    expect(reset).toHaveLength(1);
    await act(async () => reset[0].click());
    expect(puts).toContainEqual({ mapDotsOpacity: null });
    expect(state.data.project?.mapDotsOpacity).toBeUndefined();
  });

  it('offers to add one when the project has none', async () => {
    state.data = {
      settings: { look: { ...DEFAULT_LOOK } },
      project: { id: 'p1', name: 'Launch', brainPath: '', repo: '', createdAt: 0, backgroundAt: null },
    } as unknown as AppState;
    await act(async () => root.render(<LookTab />));
    expect(el.querySelector('.look-background')).toBeNull();
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent || '');
    expect(buttons.some((t) => t.includes('Add a picture'))).toBe(true);
    expect(buttons).not.toContain('Remove');
    // no picture to fade, but the map's dots still have their slider
    expect(el.textContent).not.toContain('Picture opacity');
    expect(el.textContent).toContain('Map dots opacity');
  });

  // (the page's sceneAt can be old: an agent may have made the scene since it loaded)
  it.each([
    [true, 'asks before replacing a scene the server has, whatever the page last heard'],
    [false, 'starts from a template at once when there is no scene yet'],
  ])('%s: %s', async (has) => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).startsWith('/api/scene/versions'))
          return Response.json({
            versions: has ? [{ id: 'sv-1', at: 1, by: { kind: 'agent' }, files: {} }] : [],
            newest: has ? 'sv-1' : null,
            newestGood: null,
            present: has,
            problem: null,
          });
        return Response.json({ versions: [], newest: null, newestGood: null, present: true, problem: null });
      }),
    );
    state.data = {
      settings: { look: { ...DEFAULT_LOOK, stationLook: 'scene' } },
      project: { id: 'p1', name: 'Launch', brainPath: '', repo: '', createdAt: 0, sceneAt: null },
    } as unknown as AppState;
    document.body.insertAdjacentHTML('afterbegin', '<div id="modal-root"></div>');
    await act(async () => root.render(<LookTab />));
    const garden = el.querySelector<HTMLButtonElement>('.look-scene-template')!;
    await act(async () => garden.click());
    await act(async () => vi.advanceTimersByTime(50));
    expect(urls.some((u) => u.startsWith('/api/scene/versions'))).toBe(true);
    const asked = document.querySelector('#modal-root .modal');
    expect(!!asked && /Replace this project's scene/.test(asked.textContent || '')).toBe(has);
    if (asked)
      await act(async () =>
        [...asked.querySelectorAll<HTMLButtonElement>('.modal-foot button')]
          .find((b) => b.textContent === 'Cancel')!
          .click(),
      );
    expect(urls.some((u) => u.startsWith('/api/scene/start'))).toBe(!has);
  });
});
