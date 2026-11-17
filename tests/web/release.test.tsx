// Previews let go of what they hold when they are done with: a 3D model viewer's observer (and its model), through a
// preview box's cards, and a plain-DOM piece in React only when it really goes, not when StrictMode remounts it
// (BH-154).
import { act, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelViewer } from '../../web/modelviewer.ts';
import { onRelease, release } from '../../web/release.ts';
import { filePreviews, forgetFiles } from '../../web/filepreview.tsx';
import { DomNode } from '../../web/ui/react.tsx';
import { createAppRoot } from '../../web/ui/root.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// an observer that never sees anything, and says when it is let go
const observers: { disconnected: boolean }[] = [];
class FakeObserver {
  me = { disconnected: false };
  constructor() {
    observers.push(this.me);
  }
  observe() {}
  disconnect() {
    this.me.disconnected = true;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  observers.length = 0;
  forgetFiles();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('letting go of previews', () => {
  it('a model viewer stops watching when released, once', () => {
    const box = modelViewer('/api/file?path=a.glb', 'a.glb', 1000);
    expect(observers).toEqual([{ disconnected: false }]);
    release(box);
    expect(observers[0].disconnected).toBe(true);
    release(box);
  });

  it('a plain-DOM piece in React is let go when it goes, not when StrictMode remounts it', async () => {
    const let_go = vi.fn();
    const make = () => {
      const el = document.createElement('div');
      onRelease(el, let_go);
      return el;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createAppRoot(host);
    await act(async () =>
      root.render(
        <StrictMode>
          <DomNode make={make} deps={[]} />
        </StrictMode>,
      ),
    );
    await tick();
    expect(let_go).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    await tick();
    expect(let_go).toHaveBeenCalledTimes(1);
  });

  it('a preview box released lets go of the model viewers in it', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { paths?: string[] };
      if (url === '/api/files/info')
        return new Response(
          JSON.stringify(
            (body.paths || []).map((p) => ({
              path: p,
              ok: true,
              name: 'ship.glb',
              kind: 'model',
              size: 10,
              modified: 0,
            })),
          ),
        );
      return new Response('{}');
    });
    const box = filePreviews(['/w/ship.glb']);
    document.body.append(box);
    await vi.waitFor(() => expect(observers).toHaveLength(1));
    await act(async () => release(box));
    await tick();
    expect(observers[0].disconnected).toBe(true);
  });
});
