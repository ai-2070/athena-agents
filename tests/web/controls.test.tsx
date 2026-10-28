// The tab row and the segmented switch: Base UI roles and keys, and the sliding line under the open tab.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchBox, Segmented, Tabs } from '../../web/ui/controls.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => act(() => root.unmount()));

function Demo() {
  const [tab, setTab] = useState('a');
  const [seg, setSeg] = useState('x');
  return (
    <>
      <Tabs label="Demo" tabs={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} value={tab} onChange={setTab}>
        <p id="body">{tab}</p>
      </Tabs>
      <Segmented label="Pick" options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]} value={seg} onChange={setSeg} />
    </>
  );
}

describe('tabs and the segmented switch', () => {
  it('tabs switch the panel and carry one sliding line; the switch marks the picked option', async () => {
    await act(async () => root.render(<Demo />));
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Alpha', 'Beta']);
    expect(document.querySelectorAll('.tabs .tab-indicator')).toHaveLength(1);
    await act(async () => tabs[1].click());
    expect(document.getElementById('body')!.textContent).toBe('b');
    const opts = [...document.querySelectorAll<HTMLElement>('.seg button')];
    expect(opts.map((o) => o.classList.contains('on'))).toEqual([true, false]);
    await act(async () => opts[1].click());
    expect(document.querySelectorAll('.seg button.on')).toHaveLength(1);
    expect(document.querySelector('.seg button.on')!.textContent).toBe('Y');
  });

  it('the search box has a magnifier, tells you what you typed, and clears with its ✕', async () => {
    const seen: string[] = [];
    function Box() {
      const [q, setQ] = useState('');
      return <SearchBox label="Search things" placeholder="Search things" value={q} onChange={(v) => (seen.push(v), setQ(v))} />;
    }
    await act(async () => root.render(<Box />));
    expect(document.querySelector('.search-box svg')).not.toBeNull();
    expect(document.querySelector('[aria-label="Clear the search"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search things"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'seo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toEqual(['seo']);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear the search"]')!.click());
    expect(seen).toEqual(['seo', '']);
    expect(input.value).toBe('');
  });
});
