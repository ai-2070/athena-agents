// The MCP presets people add with one click: each one has to be a complete, installable entry.
import { describe, expect, it } from 'vitest';
import { PRESETS, kindOf, presetNeeds, remoteUrl, serverName, signsInByBrowser } from '../../server/mcp.ts';
import type { McpServerConfig } from '../../server/mcp.ts';

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

  it("include OOMOL's own server, which needs a key and a team name", () => {
    const oomol = PRESETS.find((p) => p.name === 'oomol')!;
    expect(oomol.type === 'http' && oomol.url).toBe('https://connector.oomol.com/v1/mcp');
    expect(presetNeeds(oomol)).toBe('needs a key in the Authorization header and a value in the x-oo-team-name header');
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

  it("include Cua's two servers: this computer's apps, and throwaway sandbox computers", () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    const driver = by('cua-driver');
    expect(driver.type === 'stdio' && [driver.command, ...driver.args]).toEqual(['cua-driver', 'mcp']);
    // no key: it calls no AI service; the setup says how to install it on Windows and on a Mac
    expect(JSON.stringify(driver)).not.toContain('YOUR_');
    expect(presetNeeds(driver)).toMatch(/^setup: install Cua Driver /);
    expect(presetNeeds(driver)).toContain('https://cua.ai/driver/install.ps1');
    expect(presetNeeds(driver)).toContain('Screen Recording');

    const cua = by('cua');
    expect(cua.type === 'stdio' && cua.command).toBe('cua');
    const args = cua.type === 'stdio' ? cua.args : [];
    expect(args.slice(0, 2)).toEqual(['mcp', '--permissions']);
    const granted = args[2].split(',');
    // the sandbox and computer tools, and what its in-sandbox browser is driven through
    expect(granted).toEqual(expect.arrayContaining(['sandbox:all', 'computer:all', 'images:all', 'spaces:list_tools', 'spaces:call_tool']));
    // never everything: no moving logged-in sessions in, no public share links, not the whole of Spaces
    for (const g of granted) expect(g, g).not.toMatch(/^(all|spaces:all|teleport:.*|share:.*|skills:(all|record|delete))$/);
    expect(JSON.stringify(cua)).not.toContain('YOUR_');
    expect(presetNeeds(cua)).toMatch(/^setup: install the cua command .*Docker/);
  });

  it('tell the Brain what each one needs from you', () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    expect(presetNeeds(by('playwright'))).toBe('');
    expect(presetNeeds(by('brave-search'))).toBe('needs BRAVE_API_KEY');
    expect(presetNeeds(by('linear'))).toBe('setup: sign in to Linear in the browser window that opens the first time it runs');
    expect(presetNeeds(by('unity'))).toMatch(/^setup: install the "MCP for Unity" package/);
  });

  it('include services that sign in through the browser: nothing to paste, and the setup says whose sign-in opens', () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    for (const n of ['notion', 'linear', 'atlassian', 'gitlab', 'sentry', 'vercel', 'cloudflare', 'supabase', 'huggingface', 'airtable', 'miro', 'dropbox']) {
      const p = by(n);
      expect(signsInByBrowser(p), n).toBe(true);
      expect(remoteUrl(p), n).toMatch(/^https:\/\//);
      expect(p.type === 'stdio' && p.args.slice(0, 2), n).toEqual(['-y', 'mcp-remote']);
      expect(presetNeeds(p), n).toMatch(/^setup: sign in to .+ in the browser window that opens the first time it runs$/);
      expect(p.description, n).toContain('a browser window opens to sign in');
    }
    // Notion no longer asks for an integration token
    expect(JSON.stringify(by('notion'))).not.toContain('YOUR_');
    // Cloudflare stays in its small two-tool mode: the full list is thousands of tools
    expect(remoteUrl(by('cloudflare'))).toBe('https://mcp.cloudflare.com/mcp');
  });

  it('include hosted docs, search and travel servers that need no key', () => {
    const by = (name: string) => PRESETS.find((p) => p.name === name)!;
    for (const n of ['deepwiki', 'microsoft-learn', 'aws-knowledge', 'twilio-docs', 'wolfram', 'kiwi', 'trivago']) {
      const p = by(n);
      expect(p.type, n).toBe('http');
      expect(presetNeeds(p), n).toBe('');
      expect(p.description, n).toMatch(/No key needed\.$/);
      expect(signsInByBrowser(p), n).toBe(false);
    }
  });

  it('count a hosted link added straight as the browser sign-in preset it is', () => {
    const cfg = (o: Partial<McpServerConfig>): McpServerConfig => ({ type: 'http', command: '', args: [], env: {}, url: '', headers: {}, description: '', enabled: true, ...o });
    expect(kindOf('my-notion', cfg({ url: 'https://mcp.notion.com/mcp' }))).toBe('notion');
    expect(kindOf('work-sentry', cfg({ type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.sentry.dev/mcp'] }))).toBe('sentry');
    expect(kindOf('other', cfg({ url: 'https://example.com/mcp' }))).toBe('other');
  });
});
