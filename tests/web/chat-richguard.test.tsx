// A Rich answer whose component library can't load (or throws) shows the answer's own text, and the chat around it stays.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageView } from '../../web/chat/parts.tsx';
import type { ChatMessage } from '../../web/chat/messages.ts';

vi.mock('../../web/chat/rich.tsx', () => {
  throw new Error('process is not defined');
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const code = 'root = Card([t])\nt = TextContent("hi")';
const message = (parts: ChatMessage['parts']): ChatMessage => ({ id: 'm1', role: 'assistant', parts }) as ChatMessage;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('a Rich answer that can not be drawn', () => {
  it('falls back to its text, next to the messages that are fine', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
    await act(async () =>
      root!.render(
        <>
          <MessageView
            m={message([{ type: 'text', text: 'First, a plain answer.' }])}
            variant="full"
            busy={false}
            streaming={false}
            dim={false}
            onSend={() => {}}
          />
          <MessageView
            m={{ ...message([{ type: 'text', text: code }]), id: 'm2' }}
            variant="full"
            busy={false}
            streaming={false}
            dim={false}
            onSend={() => {}}
          />
        </>,
      ),
    );
    await settle();
    expect(el.textContent).toContain('First, a plain answer.');
    expect(el.querySelector('.msg.assistant.rich pre')!.textContent).toBe(code);
    quiet.mockRestore();
    el.remove();
  });
});
