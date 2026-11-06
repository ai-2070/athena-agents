import { afterEach, expect, it, vi } from 'vitest';
import { connectEvents, onEventConnection } from '../../web/core.ts';

class FakeSocket {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor() { FakeSocket.last = this; }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reports live events connecting, dropping and reconnecting to subscribers', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ project: { id: 'test' } })));
  const seen: boolean[] = [];
  const off = onEventConnection((connected) => seen.push(connected));
  connectEvents();
  const first = FakeSocket.last;
  FakeSocket.last.onopen!();
  FakeSocket.last.onclose!();
  await vi.advanceTimersByTimeAsync(1500);
  expect(FakeSocket.last).not.toBe(first);
  FakeSocket.last.onopen!();
  expect(seen).toEqual([false, true, false, true]);
  off();
  FakeSocket.last.onclose!();
  expect(seen).toEqual([false, true, false, true]);
});

// The server restarting under an open page (`bun run dev` restarts it on every server change): the page keeps
// its place, and once the socket is back it loads the state again and tells the views that missed events.
it('after the server comes back, loads the state again and tells reconnect listeners (not on the first connect)', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal('WebSocket', FakeSocket);
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ project: { id: 'test' } }))));
  const core = await import('../../web/core.ts');
  const reconnects = vi.fn();
  core.onReconnect(reconnects);
  core.connectEvents();
  FakeSocket.last.onopen!();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconnects).not.toHaveBeenCalled();
  expect(asked.filter((u) => u.endsWith('/api/state'))).toHaveLength(1);
  // the server restarts: the socket drops, and a new one opens 1.5 s later
  FakeSocket.last.onclose!();
  await vi.advanceTimersByTimeAsync(1500);
  FakeSocket.last.onopen!();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconnects).toHaveBeenCalledTimes(1);
  expect(asked.filter((u) => u.endsWith('/api/state'))).toHaveLength(2);
});
