// Lists of a project that isn't open, for Overview panes: one request at a time per project, however many panes
// show it, and only that project's panes draw again.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, connectEvents } from '../../web/core.ts';
import { projectList } from '../../web/projectlist.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));
class FakeSocket {
  static last: FakeSocket | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
}
const event = (type: string) => act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type, ts: 0 }) }));

let asked: string[];
let root: Root;
beforeEach(() => {
  asked = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    await new Promise((r) => setTimeout(r, 10));
    return new Response(JSON.stringify([{ id: `${url}#${asked.length}` }]), {
      headers: { 'content-type': 'application/json' },
    });
  });
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('projectList()', () => {
  it("asks once per project for every pane, once more for a change, and draws only that project's panes", async () => {
    const things = projectList<{ id: string }>((at) => api<{ id: string }[]>(`${at}/things`), ['things']);
    const draws: Record<string, number> = { p2: 0, p3: 0 };
    function Pane({ id }: { id: string }) {
      const list = things.use(id);
      draws[id] += 1;
      return <span className={`pane-${id}`}>{list.length}</span>;
    }
    await act(async () =>
      root.render(
        <>
          {[1, 2, 3].map((n) => (
            <Pane key={n} id="p2" />
          ))}
          <Pane id="p3" />
        </>,
      ),
    );
    await settle();
    expect(asked.sort()).toEqual(['/api/p/p2/things', '/api/p/p3/things']);
    expect(document.querySelectorAll('.pane-p2')[0].textContent).toBe('1');
    // two changes in a moment: one more request each, not one per pane
    asked = [];
    const p3Draws = draws.p3;
    await event('things');
    await event('things');
    await settle(60);
    expect(asked.filter((u) => u.includes('/p2/')).length).toBeLessThanOrEqual(2);
    expect(asked.filter((u) => u.includes('/p2/')).length).toBeGreaterThanOrEqual(1);
    // other events change nothing
    asked = [];
    await event('agents');
    await settle();
    expect(asked).toEqual([]);
    // (p3's pane drew again only for its own list)
    expect(draws.p3 - p3Draws).toBeLessThanOrEqual(2);
  });

  it('stops listening once no pane shows the project', async () => {
    const things = projectList<{ id: string }>((at) => api<{ id: string }[]>(`${at}/things`), ['things']);
    function Pane() {
      things.use('p2');
      return null;
    }
    await act(async () => root.render(<Pane />));
    await settle();
    await act(async () => root.render(null));
    asked = [];
    await event('things');
    await settle();
    expect(asked).toEqual([]);
  });
});
