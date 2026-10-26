// The Artifacts page: search across everything an artifact says about itself.
import { describe, expect, it } from 'vitest';
import { matching } from '../../web/views/artifacts.ts';
import type { Artifact } from '../../shared/types.ts';

const list: Artifact[] = [
  { id: 'a1', title: 'Microduck TikTok (13 s, 9:16)', kind: 'file', path: 'C:\\net\\video\\microduck_tiktok.mp4', note: 'Cream microduck waddles in, hops', agentName: 'Studio Producer', teamName: 'Video & Motion' },
  { id: 'a2', title: 'Weekly numbers', kind: 'text', text: 'Reach is up 12% on X this week', agentName: 'Analytics Reporter', teamName: 'Social' },
  { id: 'a3', title: 'Renders', kind: 'folder', path: 'C:\\net\\video\\renders', agentName: '3D Artist', teamName: 'Video & Motion' },
];
const ids = (q: string) => matching(list, q).map((a) => a.id);

describe('matching()', () => {
  it('shows everything for an empty search', () => {
    expect(ids('')).toEqual(['a1', 'a2', 'a3']);
    expect(ids('   ')).toEqual(['a1', 'a2', 'a3']);
  });

  it('finds by title, note, team, who made it, file name and the text of a result, in any case', () => {
    expect(ids('tiktok')).toEqual(['a1']);
    expect(ids('WADDLES')).toEqual(['a1']);
    expect(ids('video & motion')).toEqual(['a1', 'a3']);
    expect(ids('analytics')).toEqual(['a2']);
    expect(ids('mp4')).toEqual(['a1']);
    expect(ids('reach is up')).toEqual(['a2']);
    expect(ids('folder')).toEqual(['a3']);
  });

  it('needs every word, in any order', () => {
    expect(ids('video 3d')).toEqual(['a3']);
    expect(ids('hops cream')).toEqual(['a1']);
    expect(ids('video analytics')).toEqual([]);
  });
});
