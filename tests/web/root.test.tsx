// Every React root goes through createAppRoot: a piece that crashes while drawing shows a message in its place
// (the rest of the page keeps working), and comes back on Try again or when it is drawn with new content.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { createAppRoot } from '../../web/ui/root.tsx';
import { mountReact } from '../../web/ui/react.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let broken = true;
function Flaky({ label = 'drawn' }: { label?: string }) {
  if (broken) throw new Error('the piece broke');
  return <p id="ok">{label}</p>;
}

let root: Root;
let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  broken = true;
  document.body.innerHTML = '<div id="host"></div><div id="other"></div>';
  root = createAppRoot(document.getElementById('host')!);
  // React reports caught crashes on the console; keep the test output clean
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  quiet.mockRestore();
});

const alert = () => document.querySelector<HTMLElement>('#host [role="alert"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('#host button')].find((b) => b.textContent === text)!;

describe('createAppRoot', () => {
  it('shows what went wrong in place of a piece that crashes, instead of a blank space', () => {
    act(() => root.render(<Flaky />));
    expect(alert()?.textContent).toContain('Something went wrong here.');
    expect(alert()?.textContent).toContain('the piece broke');
    expect(button('Try again')).toBeTruthy();
    expect(button('Reload page')).toBeTruthy();
  });

  it('draws the piece afresh on Try again once it no longer crashes', () => {
    act(() => root.render(<Flaky />));
    broken = false;
    act(() => button('Try again').click());
    expect(alert()).toBeNull();
    expect(document.getElementById('ok')?.textContent).toBe('drawn');
  });

  it('still shows the message if Try again crashes the same way', () => {
    act(() => root.render(<Flaky />));
    act(() => button('Try again').click());
    expect(alert()?.textContent).toContain('the piece broke');
  });

  it('clears the crash when the caller draws the root again with new content', () => {
    act(() => root.render(<Flaky label="first" />));
    broken = false;
    act(() => root.render(<Flaky label="second" />));
    expect(alert()).toBeNull();
    expect(document.getElementById('ok')?.textContent).toBe('second');
  });

  it('leaves the rest of the page alone', () => {
    const other = createAppRoot(document.getElementById('other')!);
    broken = false;
    act(() => other.render(<Flaky label="fine" />));
    broken = true;
    act(() => root.render(<Flaky />));
    expect(document.querySelector('#other #ok')?.textContent).toBe('fine');
    act(() => other.unmount());
  });

  it('guards the pages mountReact draws too', () => {
    let page: { unmount: () => void } = { unmount: () => {} };
    act(() => void (page = mountReact(document.getElementById('other')!, <Flaky />)));
    expect(document.querySelector('#other [role="alert"]')?.textContent).toContain('the piece broke');
    act(() => page.unmount());
  });
});
