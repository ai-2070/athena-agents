// A stopped run in an agent chat: a quiet line (yours, or to take your new message), not a red error. And a
// message that joined the turn going on: drawn like your own, inside that turn.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageView } from '../../web/chat/parts.tsx';
import { toUIMessages } from '../../web/chat/messages.ts';
import type { ChatItem } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const draw = async (items: ChatItem[]) => {
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<>{toUIMessages(items).map((m) => <MessageView key={m.id} m={m} variant="full" busy={false} streaming={false} dim={false} onSend={() => {}} />)}</>));
  return el;
};

describe('a stopped run in the chat', () => {
  it('is a quiet line, with the work before it kept', async () => {
    const el = await draw([
      { type: 'user', text: 'do the long job' },
      { type: 'tool', id: 't1', name: 'read_file', args: { path: 'a.md' }, result: 'a', status: 'done' },
      { type: 'error', text: 'Stopped to take your new message.', stopped: 'steer' },
      // (saved before stops were marked)
      { type: 'error', text: 'Stopped.' },
      { type: 'error', text: 'rate limited' },
    ]);
    expect([...el.querySelectorAll('.st-stopped')].map((n) => n.textContent)).toEqual(['Stopped to take your new message.', 'Stopped.']);
    expect([...el.querySelectorAll('.msg.error')].map((n) => n.textContent)).toEqual(['rate limited']);
    expect(el.querySelector('details.tool .tname')!.textContent).toBe('read_file');
  });
});

describe('a message that joined the turn', () => {
  it('looks like your own message, inside the turn, with a quiet note', async () => {
    const el = await draw([
      { type: 'user', text: 'the long job' },
      { type: 'tool', id: 't1', name: 'read_file', args: { path: 'a.md' }, result: 'a', status: 'done' },
      { type: 'steer', steerId: 's1', text: 'also make it blue' },
      { type: 'assistant', text: 'Blue it is.' },
    ]);
    expect([...el.querySelectorAll('.msg.user')].map((n) => n.textContent)).toEqual(['the long job', 'also make it blue']);
    expect(el.querySelector('.msg.user.joined')!.textContent).toBe('also make it blue');
    expect(el.querySelector('.joined-note')!.textContent).toBe('Read while it worked');
    expect(el.querySelectorAll('.msg.error')).toHaveLength(0);
  });
});
