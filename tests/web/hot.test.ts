// Hot reload's rule on the page's side: React may swap a page in web/views/ in place, leaving the router's hooks
// out of its check (they keep their first version until the next reload).
import { describe, expect, it } from 'vitest';
import { VIEW_EXPORTS, ignoredExports, installHotRules } from '../../web/dev/hot.ts';

describe('ignoredExports', () => {
  it("leaves a page's router hooks out of React's check", () => {
    expect(ignoredExports('/Users/me/athena/web/views/home.tsx')).toEqual([...VIEW_EXPORTS]);
    expect(ignoredExports('C:\\Users\\me\\athena\\web\\views\\tasks.tsx')).toEqual([...VIEW_EXPORTS]);
    expect(ignoredExports('/Users/me/athena/web/views/home.tsx?t=123')).toEqual([...VIEW_EXPORTS]);
  });

  it('checks every other file in full', () => {
    for (const id of ['/Users/me/athena/web/app.ts', '/Users/me/athena/web/views/station.ts', '/Users/me/athena/web/views/sub/x.tsx', '/Users/me/athena/web/ui/button.tsx', '/Users/me/athena/web/chat/views/x.tsx'])
      expect(ignoredExports(id), id).toEqual([]);
  });

  it("is what React's refresh runtime asks once installed", () => {
    installHotRules(window);
    expect(window.__getReactRefreshIgnoredExports?.({ id: '/a/web/views/home.tsx' })).toEqual([...VIEW_EXPORTS]);
    expect(window.__getReactRefreshIgnoredExports?.({ id: '/a/web/core.ts' })).toEqual([]);
  });
});
