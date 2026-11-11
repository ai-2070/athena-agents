import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { mark, appLogo } from '../../web/views/stationdata.ts';
import { programIcon } from '../../web/programicons.ts';
import { VSCodeIcon } from '../../web/ui/fileicons.tsx';
import { brandMark } from '../../web/brand.ts';
import { BrandMark } from '../../web/views/about.tsx';
import { setConnection } from '../../web/client/connection.ts';
import { brandColor } from '../../web/icons.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => setConnection());

it('uses the same helmet in the Station and About, including on another server', async () => {
  setConnection({ base: 'http://127.0.0.1:4900' });
  const mark = brandMark(18, 'test-mark');
  expect(mark.src).toBe('http://127.0.0.1:4900/icon.png');
  expect(mark.width).toBe(18);
  expect(mark.height).toBe(18);
  expect(mark.alt).toBe('');
  expect(mark.classList.contains('test-mark')).toBe(true);

  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BrandMark size={48} />));
    const image = host.querySelector('img')!;
    expect(image.src).toBe(mark.src);
    expect(image.width).toBe(48);
    expect(image.getAttribute('aria-hidden')).toBe('true');
  } finally {
    act(() => root.unmount());
  }
});

it('shares local engine marks between the Station and program list on another server', () => {
  setConnection({ base: 'http://127.0.0.1:4900' });
  for (const id of ['hermes', 'pi', 'omp', 'openclaw', 'opencode', 'venice', 'vscode']) {
    const station = mark(id, 15) as HTMLImageElement;
    expect(station.tagName.toLowerCase()).toBe('img');
    expect(station.src).toBe((programIcon(id, id, 15) as HTMLImageElement).src);
    expect(station.src).toContain('http://127.0.0.1:4900/brand/engines/');
    expect((appLogo(id, 15) as HTMLImageElement).src).toBe(station.src);
    expect(station.width).toBe(15);
  }
});

it('uses the official VS Code ribbon for the folder action', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<VSCodeIcon size={16} />));
    const image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/brand/engines/vscode.png');
    expect(image.width).toBe(16);
    expect(image.alt).toBe('');
  } finally {
    act(() => root.unmount());
  }
});

it('uses the white pi and Venice marks on a dark page and swaps marks already shown when the look changes', async () => {
  const root = document.documentElement;
  const shown = programIcon('pi', 'pi', 15) as HTMLImageElement;
  document.body.append(shown);
  try {
    expect(shown.getAttribute('src')).toBe('/brand/engines/pi.svg');
    root.dataset.theme = 'dark';
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.getAttribute('src')).toBe('/brand/engines/pi-dark.svg');
    expect((mark('pi', 15) as HTMLImageElement).getAttribute('src')).toBe('/brand/engines/pi-dark.svg');
    expect((mark('venice', 15) as HTMLImageElement).getAttribute('src')).toBe('/brand/engines/venice-dark.svg');
    // marks without a dark copy stay as they are
    expect((mark('omp', 15) as HTMLImageElement).getAttribute('src')).toBe('/brand/engines/omp.svg');
    root.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.getAttribute('src')).toBe('/brand/engines/pi.svg');
  } finally {
    shown.remove();
    root.removeAttribute('data-theme');
  }
});

it('draws the OpenAI and Codex marks in black on a light page and white on a dark one, never purple', () => {
  const root = document.documentElement;
  const fills = () =>
    [appLogo('openai', 15), mark('codex', 15), programIcon('codex', 'codex', 15)].map((el) =>
      (el as SVGSVGElement).querySelector('path')!.getAttribute('fill'),
    );
  try {
    root.dataset.theme = 'light';
    for (const fill of fills()) expect(fill?.toLowerCase()).not.toBe('#412991');
    expect(brandColor('openai')).toBe('#000000');
    root.dataset.theme = 'dark';
    for (const fill of fills()) expect(fill?.toLowerCase()).not.toBe('#412991');
    expect(brandColor('openai')).toBe('#e6e8e0');
    expect(brandColor('codex')).toBe('#e6e8e0');
  } finally {
    root.removeAttribute('data-theme');
  }
});
