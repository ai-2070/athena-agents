// How strong a project's Station background picture and map dots are: whole percents from 0 to 100, per project.
import { describe, expect, it } from 'vitest';
import { createProject, updateProject } from '../../server/projects.ts';
import { listProjects } from '../../server/store.ts';
import { backgroundOpacity, mapDotsOpacity, savedOpacity, toPercent } from '../../shared/look.ts';

describe('Station opacities', () => {
  it('are saved per project, rounded and kept between 0 and 100', async () => {
    const a = await createProject({ name: 'Faint' });
    const b = await createProject({ name: 'Untouched' });
    expect(updateProject(a.id, { backgroundOpacity: 33.6, mapDotsOpacity: 140 })).toMatchObject({ backgroundOpacity: 34, mapDotsOpacity: 100 });
    expect(updateProject(a.id, { mapDotsOpacity: -5 }).mapDotsOpacity).toBe(0);
    const other = listProjects().find((x) => x.id === b.id)!;
    expect(other.backgroundOpacity).toBeUndefined();
    expect(other.mapDotsOpacity).toBeUndefined();
  });

  it('null puts the default back, and anything that is not a number is refused', async () => {
    const p = await createProject({ name: 'Reset' });
    updateProject(p.id, { backgroundOpacity: 20, mapDotsOpacity: 10 });
    const after = updateProject(p.id, { backgroundOpacity: null });
    expect(after.backgroundOpacity).toBeUndefined();
    expect(after.mapDotsOpacity).toBe(10);
    expect(() => updateProject(p.id, { mapDotsOpacity: 'lots' })).toThrow(/percent/);
    expect(listProjects().find((x) => x.id === p.id)?.mapDotsOpacity).toBe(10);
  });

  it('fall back to the look’s own values', () => {
    expect(backgroundOpacity({}, 'classic')).toBe(50);
    expect(backgroundOpacity({}, 'world')).toBe(100);
    expect(backgroundOpacity({ backgroundOpacity: 0 }, 'world')).toBe(0);
    expect(mapDotsOpacity(undefined)).toBe(100);
    expect(toPercent('40%')).toBe(40);
    expect(toPercent('')).toBeNull();
    expect(savedOpacity({ backgroundOpacity: 'x', mapDotsOpacity: 70 })).toEqual({ mapDotsOpacity: 70 });
  });
});
