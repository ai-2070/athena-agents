import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { brandMark } from '../../web/brand.ts';
import { BrandMark } from '../../web/views/about.tsx';
import { setConnection } from '../../web/client/connection.ts';

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
