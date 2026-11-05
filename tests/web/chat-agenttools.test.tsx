// ask_agent and await_agent in a chat: the card says which agent, with its icon, not a handle.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { state } from '../../web/core.ts';
import { Handoffs, MessageView } from '../../web/chat/parts.tsx';
import { handoffMap, handoffsIn, toUIMessages, toolBase } from '../../web/chat/messages.ts';
import type { AppState, ChatItem } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
beforeEach(() => {
  state.data = { runs: [], approvals: [], agents: [{ id: 'maker', name: 'Maker', emoji: '🎨', color: '#f60' }, { id: 'writer', name: 'Writer', emoji: '✍️' }] } as unknown as AppState;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const ITEMS: ChatItem[] = [
  { type: 'user', text: 'make the launch kit' },
  { type: 'tool', id: 'a1', name: 'mcp__dashboard__ask_agent', args: { agent: 'Maker', message: 'make the thumbnail' }, result: 'Sent to Maker (handle hmw2ab0by5a917f69). They are working on it now. Get the answer with await_agent and handle "hmw2ab0by5a917f69".', status: 'done' },
  { type: 'tool', id: 'a2', name: 'ask_agent', args: { agent: 'Writer', message: 'write the post' }, result: 'Sent to Writer (handle h2). They are working on it now.', status: 'done' },
  { type: 'tool', id: 'w1', name: 'await_agent', args: { handle: 'hmw2ab0by5a917f69' }, result: null, status: 'running' },
  { type: 'tool', id: 'w2', name: 'await_agent', args: { handles: ['hmw2ab0by5a917f69', 'h2'], all: true }, result: null, status: 'running' },
  // (a handle from before this chat's memory: shown as it is)
  { type: 'tool', id: 'w3', name: 'await_agent', args: { handle: 'hold' }, result: null, status: 'running' },
];

describe('agent tool cards', () => {
  it('ask_agent and await_agent name the agent with its icon', async () => {
    const messages = toUIMessages(ITEMS);
    const el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
    await act(async () =>
      root!.render(
        <Handoffs.Provider value={handoffMap(handoffsIn(messages))}>
          {messages.map((m) => <MessageView key={m.id} m={m} variant="full" busy streaming={false} dim={false} onSend={() => {}} />)}
        </Handoffs.Provider>,
      ),
    );
    const summaries = [...el.querySelectorAll('details.tool summary')];
    const agents = (s: Element) => [...s.querySelectorAll('.tool-agent')].map((a) => a.textContent);
    expect(agents(summaries[0])).toEqual(['🎨Maker']);
    expect(summaries[0].querySelector('.targ')!.textContent).toBe('🎨Maker · make the thumbnail');
    expect(agents(summaries[2])).toEqual(['🎨Maker']);
    expect(summaries[2].textContent).not.toContain('hmw2ab0by5a917f69');
    expect(agents(summaries[3])).toEqual(['🎨Maker', '✍️Writer']);
    expect(agents(summaries[4])).toEqual([]);
    expect(summaries[4].querySelector('.targ')!.textContent).toBe('hold');
  });

  it('reads tool names with or without an MCP prefix', () => {
    expect(toolBase('mcp__dashboard__await_agent')).toBe('await_agent');
    expect(toolBase('await_agent')).toBe('await_agent');
  });
});
