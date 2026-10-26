// The MCP presets people add with one click: each one has to be a complete, installable entry.
import { describe, expect, it } from 'vitest';
import { PRESETS, presetNeeds, serverName } from '../../server/mcp.ts';

describe('MCP presets', () => {
  it('have unique names that are safe as saved names', () => {
    const names = PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(serverName(n)).toBe(n);
    expect(names).not.toContain('dashboard'); // reserved for the built-in tools
  });

  it('are complete: a title, a plain description, and a command or an https address', () => {
    for (const p of PRESETS) {
      expect(p.title.length, p.name).toBeGreaterThan(2);
      expect(p.description.length, p.name).toBeGreaterThan(20);
      if (p.type === 'stdio') {
        expect(p.command, p.name).toBeTruthy();
        expect(p.args.length, p.name).toBeGreaterThan(0);
      } else expect(p.url, p.name).toMatch(/^https:\/\//);
    }
  });

  it('say so when you must fill in a key, and name where', () => {
    for (const p of PRESETS) {
      const secrets = p.type === 'stdio' ? p.env || {} : p.headers;
      for (const [k, v] of Object.entries(secrets)) {
        if (!/YOUR_/.test(v)) continue;
        // an env key is named in the description; a header placeholder is explained there too
        expect(p.description, `${p.name} ${k}`).toMatch(p.type === 'stdio' ? new RegExp(k) : /Authorization header|key|token/i);
      }
    }
  });

  it('include the game engines and ElevenLabs', () => {
    const names = PRESETS.map((p) => p.name);
    for (const n of ['unity', 'unreal', 'godot', 'elevenlabs']) expect(names).toContain(n);
  });

  it('include Maya, Houdini and Substance Painter, each with its setup step', () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name);
    for (const n of ['maya', 'houdini', 'substance-painter']) expect(presetNeeds(by(n)!), n).toMatch(/^setup: /);
    expect(presetNeeds(by('maya')!)).toContain('commandPort');
    expect(presetNeeds(by('substance-painter')!)).toContain('--enable-remote-scripting');
  });

  it('include 3D sources, stock images, design and free creative programs', () => {
    const names = PRESETS.map((p) => p.name);
    for (const n of ['tripo', 'meshy', 'sketchfab', 'unsplash', 'pixabay', 'pexels', 'canva', 'freepik', 'google-design', 'gimp', 'krita', 'inkscape', 'audacity', 'reaper', 'musescore', 'obs', 'topaz']) {
      expect(names, n).toContain(n);
    }
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    expect(presetNeeds(by('unsplash'))).toBe('needs UNSPLASH_ACCESS_KEY');
    expect(presetNeeds(by('google-design'))).toBe('');
    // Canva and Freepik sign in through the browser, so they say so instead of asking for a key
    expect(presetNeeds(by('canva'))).toMatch(/^setup: sign in/);
    expect(presetNeeds(by('audacity'))).toMatch(/Audacity 3/);
    // Tripo's usage tracking stays off; it is not a key the user has to fill in
    expect(presetNeeds(by('tripo'))).toBe('needs TRIPO_API_KEY');
  });

  it('tell the Brain what each one needs from you', () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    expect(presetNeeds(by('playwright'))).toBe('');
    expect(presetNeeds(by('brave-search'))).toBe('needs BRAVE_API_KEY');
    expect(presetNeeds(by('linear'))).toBe('needs a key in the Authorization header');
    expect(presetNeeds(by('unity'))).toMatch(/^setup: install the "MCP for Unity" package/);
  });
});
