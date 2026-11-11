import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Project } from '../../shared/types.ts';
import { state } from '../../web/core.ts';
import { openProjectMenu } from '../../web/projects.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
let anchor: HTMLButtonElement;
let requests: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  document.body.innerHTML = '<button id="anchor">Projects</button><div id="toasts"></div><div id="modal-root"></div>';
  Element.prototype.getAnimations ??= () => [];
  anchor = document.querySelector('#anchor')!;
  requests = [];
  const projects = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
  ] as Project[];
  state.data = { project: projects[0], projects } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push({ method: init.method || 'GET', url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }));
  });
});

afterEach(async () => {
  const popup = document.querySelector('.proj-menu');
  if (popup) {
    await act(async () => {
      popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
  }
  vi.unstubAllGlobals();
});

const open = async () => {
  anchor.focus();
  await act(async () => {
    openProjectMenu(anchor);
  });
  await settle();
};
const row = (id: string) => document.querySelector<HTMLElement>(`.proj-menu [data-id="${id}"]`)!;
const item = (id: string) => row(id).querySelector<HTMLButtonElement>('.st-menu-item')!;
const key = async (target: Element, name: string, options: KeyboardEventInit = {}) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }));
  });
  await settle();
};

describe('project menu', () => {
  it('opens with the current project marked and selecting another activates it', async () => {
    await open();
    expect(document.querySelector('.proj-menu .st-menu-head')?.textContent).toBe('Projects');
    expect(item('a').classList.contains('on')).toBe(true);
    expect([...document.querySelectorAll('.proj-menu [data-id]')].map((el) => el.getAttribute('data-id'))).toEqual([
      'a',
      'b',
      'c',
    ]);
    await act(async () => {
      item('b').click();
    });
    await settle();
    expect(requests.filter((r) => r.url === '/api/projects/b/activate')).toMatchObject([
      { method: 'POST', url: '/api/projects/b/activate' },
    ]);
    expect(document.querySelector('.proj-menu')).toBeNull();
  });

  it('closes on Escape and returns focus to the anchor', async () => {
    await open();
    item('b').focus();
    await key(item('b'), 'Escape');
    expect(document.querySelector('.proj-menu')).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('dismisses on an outside click without activating a project', async () => {
    await open();
    const outside = document.createElement('button');
    document.body.append(outside);
    item('b').focus();
    await act(async () => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      outside.focus();
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(document.querySelector('.proj-menu')).toBeNull();
    expect(requests.filter((r) => r.url.includes('/activate'))).toEqual([]);
  });

  it('opens inline rename with F2 and Escape cancels without closing the menu', async () => {
    await open();
    item('b').focus();
    await key(item('b'), 'F2');
    const input = document.querySelector<HTMLInputElement>('.proj-rename-row input')!;
    expect(input.value).toBe('Beta');
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await key(input, 'Escape');
    expect(document.querySelector('.proj-menu')).not.toBeNull();
    expect(item('b').textContent).toContain('Beta');
    expect(document.activeElement).toBe(item('b'));
    expect(requests.filter((r) => r.method === 'PUT')).toEqual([]);
  });

  it('reorders with Alt+Arrow and saves the exact new order', async () => {
    await open();
    item('b').focus();
    await key(item('b'), 'ArrowUp', { altKey: true });
    expect([...document.querySelectorAll('.proj-menu [data-id]')].map((el) => el.getAttribute('data-id'))).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(requests.filter((r) => r.url === '/api/projects/order')).toEqual([
      { method: 'POST', url: '/api/projects/order', body: { ids: ['b', 'a', 'c'] } },
    ]);
    expect(document.activeElement).toBe(item('b'));
  });
});
