// The floating window's agent tab: focus asked for before its chat has loaded is given once it has.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { renderAgentChat } from '../../web/agentchat.ts';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('renderAgentChat()', () => {
  it('focus asked for right away lands in the message box once the chat is there', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'openai', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url === '/api/agents/a1/chats' ? [] : {}), { headers: { 'content-type': 'application/json' } }));
    const el = document.createElement('div');
    document.body.append(el);
    const tab = renderAgentChat(el, 'a1');
    // (what chatwin.ts does a moment after opening a tab: the chat is still loading)
    tab.focus();
    for (let i = 0; i < 100 && document.activeElement?.tagName !== 'TEXTAREA'; i++) await settle();
    expect(document.activeElement).toBe(el.querySelector('textarea'));
    tab.destroy();
  });
});
