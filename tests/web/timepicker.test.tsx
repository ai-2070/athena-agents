import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TimePicker } from '../../web/ui/timepicker.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let changed = vi.fn<(value: string) => void>();
beforeEach(async () => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
  changed = vi.fn<(value: string) => void>();
  await act(async () => root.render(<TimePicker label="Reminder time" value="09:30" onChange={changed} />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); });
const click = (element: Element) => act(async () => (element as HTMLElement).click());
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
const open = () => click(document.querySelector('[data-time-picker]')!);
const lists = () => [...document.querySelectorAll('[role="listbox"]')];
const option = (column: number, text: string) => [...lists()[column].querySelectorAll('[role="option"]')].find((o) => o.textContent === text)!;

it('shows AM/PM and confirms column picks as a 24-hour time', async () => {
  expect(document.querySelector('[data-time-picker]')!.textContent).toContain('09:30 AM');
  await open();
  await click(option(0, '02'));
  await click(option(1, '45'));
  await click(option(2, 'PM'));
  expect(changed).not.toHaveBeenCalled();
  await click(button('OK'));
  expect(changed).toHaveBeenCalledWith('14:45');
});

it('supports keyboard columns and discards a draft on Escape', async () => {
  await open();
  await act(async () => lists()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(document.activeElement).toBe(lists()[1]);
  await act(async () => lists()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(option(1, '31').getAttribute('aria-selected')).toBe('true');
  await act(async () => lists()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(changed).not.toHaveBeenCalled();
  await open();
  expect(option(1, '30').getAttribute('aria-selected')).toBe('true');
});

it('keeps Now and Clear as drafts until OK', async () => {
  vi.spyOn(Date.prototype, 'getHours').mockReturnValue(17);
  vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(23);
  await open();
  await click(button('Now'));
  expect(option(0, '05').getAttribute('aria-selected')).toBe('true');
  expect(option(1, '23').getAttribute('aria-selected')).toBe('true');
  expect(option(2, 'PM').getAttribute('aria-selected')).toBe('true');
  expect(changed).not.toHaveBeenCalled();
  await click(button('Clear'));
  expect(document.querySelector('[aria-selected="true"]')).toBeNull();
  await click(button('OK'));
  expect(changed).toHaveBeenCalledWith('');
});
