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
