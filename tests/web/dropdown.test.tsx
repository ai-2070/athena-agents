// The app's dropdown (ReUI's DropdownMenu on Base UI) and the menus built on it: the paperclip's, and the picker of one choice.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropdown, DropdownContent, DropdownGroup, DropdownItem, DropdownLabel, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator, DropdownTrigger } from '../../web/ui/dropdown.tsx';
import { SelectControl } from '../../web/ui/select.tsx';
import { attachTray } from '../../web/attach.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

let root: Root;
beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  // (no animations in happy-dom)
  Element.prototype.getAnimations ??= () => [];
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => act(() => root.unmount()));

const menu = () => document.querySelector('.st-menu');
const rows = (role = 'menuitem') => [...document.querySelectorAll<HTMLElement>(`.st-menu [role="${role}"]`)];
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};

describe('the dropdown', () => {
  it('opens from its button with icons, labels, a heading and a divider, and runs what you pick', async () => {
    const ran: string[] = [];
    await act(async () =>
      root.render(
        <Dropdown>
          <DropdownTrigger className="t">Options</DropdownTrigger>
          <DropdownContent>
            <DropdownGroup>
              <DropdownLabel>My account</DropdownLabel>
              <DropdownItem icon="user" onClick={() => ran.push('profile')}>
                Profile
              </DropdownItem>
            </DropdownGroup>
            <DropdownSeparator />
            <DropdownItem icon="trash-2" danger onClick={() => ran.push('delete')}>
              Delete
            </DropdownItem>
          </DropdownContent>
        </Dropdown>,
      ),
    );
    expect(menu()).toBeNull();
    await click(document.querySelector('.t')!);
    expect(menu()).not.toBeNull();
    expect(document.querySelector('.st-menu .st-menu-head')!.textContent).toBe('My account');
    expect(document.querySelectorAll('.st-menu .st-menu-sep')).toHaveLength(1);
    expect(rows().map((r) => r.textContent!.trim())).toEqual(['Profile', 'Delete']);
    expect(rows()[0].querySelector('svg')).not.toBeNull();
    expect(rows()[1].classList.contains('danger')).toBe(true);
    await click(rows()[0]);
    expect(ran).toEqual(['profile']);
    // picking closes it
    expect(menu()).toBeNull();
  });

  it('is one choice out of several: the picked one is checked, and picking another tells you and closes', async () => {
    const picked: string[] = [];
    await act(async () =>
      root.render(
        <Dropdown>
          <DropdownTrigger className="t">To</DropdownTrigger>
          <DropdownContent>
            <DropdownRadioGroup value="b" onValueChange={(v) => picked.push(String(v))}>
              <DropdownRadioItem value="a">First</DropdownRadioItem>
              <DropdownRadioItem value="b">Second</DropdownRadioItem>
            </DropdownRadioGroup>
          </DropdownContent>
        </Dropdown>,
      ),
    );
    await click(document.querySelector('.t')!);
    expect(rows('menuitemradio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await click(rows('menuitemradio')[0]);
    expect(picked).toEqual(['a']);
    expect(menu()).toBeNull();
  });
});

describe('the select control', () => {
  it('offers the empty option and returns its value when selected', async () => {
    const picked: string[] = [];
    await act(async () => root.render(<SelectControl aria-label="Service" value="work" onChange={(value) => picked.push(value)} options={[{ value: '', label: 'Its own service' }, { value: 'work', label: 'Work' }]} />));
    await click(document.querySelector('button[aria-label="Service"]')!);
    expect(rows('option').map((row) => row.textContent?.trim())).toEqual(['Its own service', 'Work']);
    await click(rows('option')[0]);
    expect(picked).toEqual(['']);
  });
});

describe('the paperclip', () => {
  it('opens Files… and A folder… from the app dropdown, and each asks its own picker', async () => {
    const tray = attachTray();
    document.getElementById('host')!.append(tray.picker);
    // (its React tree draws a moment after the tray is made)
    await settle();
    const inputs = [...tray.picker.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs).toHaveLength(2);
    const asked = inputs.map((i) => vi.spyOn(i, 'click'));
    const clip = tray.picker.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    expect(clip.classList.contains('btn')).toBe(true);
    await click(clip);
    expect(rows().map((r) => r.textContent!.trim())).toEqual(['Files…', 'A folder…']);
    await click(rows()[1]);
    expect(asked.map((s) => s.mock.calls.length)).toEqual([0, 1]);
    expect(menu()).toBeNull();
    await click(clip);
    await click(rows()[0]);
    expect(asked.map((s) => s.mock.calls.length)).toEqual([1, 1]);
  });
});
