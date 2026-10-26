// The Brain chat (React): opening from the button, who a message goes to, and /queue while it works.
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { initDock } from '../../web/dock.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

// a Brain answer that stays on its way until the test ends it
let answering: ReadableStreamDefaultController<Uint8Array> | null = null;
beforeAll(() => {
  document.body.append(Object.assign(document.createElement('div'), { id: 'toasts' }));
  // (no animations in happy-dom)
  Element.prototype.animate ??= function () {
    return { finished: Promise.resolve(), cancel() {}, onfinish: null, effect: null } as unknown as Animation;
  };
  Element.prototype.getAnimations ??= () => [];
  state.data = {
    runs: [],
    approvals: [],
    agents: [{ id: 'a1', name: 'Scout', emoji: '🔭', engine: 'openai', model: 'm', provider: 'custom' }],
    project: { id: 'p1', name: 'P' },
    settings: { brain: { provider: 'claude', model: 'haiku' } },
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/brain/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (answering = c) }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
    if (url === '/api/brain/history') return json([]);
    if (url === '/api/workflows') return json([{ id: 't1', name: 'Thumbs', members: ['a1'], lead: 'a1', steps: [] }]);
    return json({});
  });
  initDock();
});
afterAll(() => vi.unstubAllGlobals());

const panel = () => document.querySelector<HTMLElement>('.dock')!;
const launcher = () => document.querySelector<HTMLButtonElement>('.bottom-bar .dock-launcher')!;
const input = () => document.querySelector<HTMLTextAreaElement>('.dock-input')!;
const enter = () => act(async () => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

describe('the Brain chat', () => {
  it('opens from its button in the bottom bar, and Ctrl+K closes it', async () => {
    await settle();
    expect(panel().classList.contains('hidden')).toBe(true);
    await act(async () => launcher().click());
    expect(panel().classList.contains('hidden')).toBe(false);
    expect(launcher().classList.contains('hidden')).toBe(true);
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    await settle();
    expect(launcher().classList.contains('hidden')).toBe(false);
    expect(panel().classList.contains('hidden')).toBe(true);
  });

  it('sends to the Brain, an agent or a team, and shows whose model answers', async () => {
    await act(async () => launcher().click());
    await settle();
    const sel = document.querySelector<HTMLSelectElement>('.dock-target')!;
    expect([...sel.options].map((o) => o.value)).toEqual(['auto', 'new-agent', 'new-branch', 'a:a1', 'b:t1']);
    expect(sel.value).toBe('auto');
    await act(async () => {
      sel.value = 'a:a1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(sel.value).toBe('a:a1');
    expect(document.querySelector('.dock-model .model-chip')).not.toBeNull();
    await act(async () => {
      sel.value = 'b:t1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.querySelector('.dock-model')!.textContent).toContain('★');
    await act(async () => {
      sel.value = 'auto';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  it('/queue waits while the Brain is answering, and × takes it back', async () => {
    input().value = 'plan the week';
    await enter();
    for (let i = 0; i < 50 && !answering; i++) await settle();
    expect(document.querySelector('.dock-list')!.textContent).toContain('The Brain is looking at the project…');
    expect(input().placeholder).toContain('/queue');
    input().value = '/queue then the newsletter';
    await enter();
    await settle();
    const waiting = document.querySelector('.queued-list.dock-held')!;
    expect(waiting.classList.contains('hidden')).toBe(false);
    expect(waiting.querySelector('.queued-head')!.textContent).toBe('Sends when everything above is done');
    expect(waiting.querySelector('.queued-text')!.textContent).toBe('then the newsletter');
    await act(async () => waiting.querySelector<HTMLButtonElement>('button[aria-label="Don\'t send this"]')!.click());
    await settle();
    expect(waiting.classList.contains('hidden')).toBe(true);
    // (the message you sent first stays at the top)
    expect(document.querySelector('.dock-msg.user')!.textContent).toBe('plan the week');
  });
});
