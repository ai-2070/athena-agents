import { describe, expect, it } from 'vitest';
import { programIcon } from '../../web/programicons.ts';
import { icon, logo } from '../../web/icons.ts';

const path = (el: Element | null): string | null => (el && el.tagName.toLowerCase() === 'svg' ? el.querySelector('path')?.getAttribute('d') ?? null : null);

describe('programIcon', () => {
  it('draws the Claude Code mark for the Claude Code program, not the Claude model\'s', () => {
    expect(path(programIcon('claude', 'Claude Code'))).toBe(path(logo('claude code')));
    expect(path(programIcon('claude', 'Claude Code'))).not.toBe(path(logo('claude')));
  });

  it('falls back to a line icon, and to the app icon where one is a PNG', () => {
    const line = programIcon('omp', 'oh-my-pi');
    expect(line?.tagName.toLowerCase()).toBe('svg');
    expect(line?.getAttribute('fill')).toBe('currentColor');
    expect(programIcon('comfyui', 'ComfyUI')?.tagName.toLowerCase()).toBe('img');
  });

  it('never draws nothing, even for a name it has not seen', () => {
    expect(path(programIcon('nope', 'No Such Program'))).toBe(path(icon('box')));
  });
});
