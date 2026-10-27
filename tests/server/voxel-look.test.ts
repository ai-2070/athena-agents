// world_look asks the open Station tabs for a picture; the first good answer wins, words when none comes.
import { describe, expect, it } from 'vitest';
import { bus } from '../../server/store.ts';
import { deliverLook, requestLook } from '../../server/voxel/look.ts';
import { callTool } from '../../server/tools.ts';
import { newAgent } from '../../server/library.ts';
import { build } from '../../server/voxel/build.ts';
import type { ServerEvent } from '../../shared/types.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('world_look', () => {
  it('asks the tabs, takes the first picture, ignores bad and late ones', async () => {
    const seen: ServerEvent[] = [];
    const on = (e: ServerEvent) => seen.push(e);
    bus.on('event', on);
    const p = requestLook('w1', 'p1', { target: 'overview', width: 1024, height: 640 }, 2000);
    bus.off('event', on);
    const ask = seen.find((e) => e.type === 'world-look') as ServerEvent & { request: string; view: { target: string } };
    expect(ask.view.target).toBe('overview');
    expect(deliverLook(ask.request, { error: 'not in the voxel look' })).toBe(false);
    expect(deliverLook(ask.request, { image: 'data:text/html;base64,PGI+' })).toBe(false);
    expect(deliverLook(ask.request, { image: PNG })).toBe(true);
    expect(deliverLook(ask.request, { image: PNG })).toBe(false);
    expect(await p).toEqual({ image: PNG });
  });

  it('gives up when nobody answers', async () => {
    expect(await requestLook('w1', 'p1', { target: 'brain', width: 10, height: 10 }, 30)).toEqual({ image: null, note: 'no open Station answered' });
  });

  it('the tool returns the picture, or a map in words for an object', async () => {
    const a = newAgent({ name: 'Looker', toolGroups: ['world'], autonomy: 'full' });
    expect((await callTool(a, 'world_look', {})).text).toMatch(/no world yet/i);
    build({ by: { kind: 'agent', id: a.id, name: 'Looker' }, object: 'Hut', steps: [{ box: [3, 2, 3], use: 'wood' }] });
    const answer = (e: ServerEvent) => {
      if (e.type === 'world-look') setTimeout(() => deliverLook((e as ServerEvent & { request: string }).request, { image: PNG }), 5);
    };
    bus.on('event', answer);
    const r = await callTool(a, 'world_look', { target: 'object', name: 'hut', azimuth: 120 });
    bus.off('event', answer);
    expect(r.text).toMatch(/"Hut" in ".*" \(station, from 120°\)/);
    expect(r.images).toEqual([PNG]);
    expect((await callTool(a, 'world_look', { target: 'object', name: 'Nope' })).isError).toBe(true);
  }, 20_000);
});

describe('world_look with no page open', () => {
  it("doesn't wait when no page is open", async () => {
    const { setOpenPages } = await import('../../server/voxel/look.ts');
    setOpenPages(() => 0);
    const t = Date.now();
    expect(await requestLook('w1', 'p1', { target: 'overview', width: 10, height: 10 })).toEqual({ image: null, note: 'no page is open' });
    expect(Date.now() - t).toBeLessThan(500);
    setOpenPages(() => 1);
  });
});
