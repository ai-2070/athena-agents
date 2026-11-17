// A chat's reconnect (picking up a run going in it) stops when the AI SDK stops it: a view that closes or a steer
// doesn't leave the request waiting (BH-029).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatTransport } from '../../web/chat/transport.ts';

afterEach(() => vi.unstubAllGlobals());

describe('chatTransport().reconnectToStream()', () => {
  it('passes the stop on to its request', async () => {
    let seen: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      (input: Request | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (input instanceof Request ? input.signal : null) || init?.signal || null;
          seen = signal;
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const stop = new AbortController();
    const going = chatTransport('a1', () => 'c1').reconnectToStream({ chatId: 'c1', abortSignal: stop.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toBeNull();
    stop.abort();
    await expect(going).rejects.toThrow();
  });
});
