// Installing skills from GitHub (a fake GitHub here: no network), by hand and by the Brain.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGitHubUrl, installFromGitHub, reposIn } from '../../server/skillinstall.ts';
import * as skills from '../../server/skills.ts';
import { historyOf } from '../../server/history.ts';
import { ask, clearHistory } from '../../server/overseer.ts';
import { agents, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';

// the "model" gives the answers queued here
const answers: string[] = [];
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async () => answers.shift() ?? 'Ok.',
}));

// owner/repo -> ref -> path -> content
const repos: Record<string, Record<string, Record<string, string>>> = {
  'acme/skills': {
    main: {
      'README.md': 'repo readme',
      'skills/writer/SKILL.md': '---\nname: Writer\ndescription: Use when writing.\nallowed-tools: Read\n---\n\nWrite well.',
      'skills/writer/examples/one.md': 'example one',
      'skills/writer/../../escape.md': 'nope',
      'skills/writer/.hidden': 'hidden',
      'skills/editor/SKILL.md': '---\nname: Editor\ndescription: Use when editing.\n---\n\nEdit well.',
      'skills/editor/nested/SKILL.md': '---\nname: Nested\ndescription: Use nested.\n---\n\nNested.',
      'other/notes.md': 'no skill here',
    },
    'feature/x': { 'SKILL.md': '---\nname: Branch skill\ndescription: Use on the branch.\n---\n\nFrom a branch.' },
  },
};
let calls: string[] = [];
const fakeFetch = async (input: string | URL) => {
  const url = String(input);
  calls.push(url);
  const ok = (body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });
  let m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
  if (m) return repos[`${m[1]}/${m[2]}`] ? ok({ default_branch: 'main' }) : notFound();
  m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
  if (m) {
    const files = repos[`${m[1]}/${m[2]}`]?.[decodeURIComponent(m[3])];
    return files ? ok({ tree: Object.entries(files).map(([p, c]) => ({ path: p, type: 'blob', size: c.length })) }) : notFound();
  }
  m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (m) {
    const rest = m[3].split('/').map(decodeURIComponent);
    for (const [ref, files] of Object.entries(repos[`${m[1]}/${m[2]}`] || {})) {
      const n = ref.split('/').length;
      if (rest.slice(0, n).join('/') === ref && rest.slice(n).join('/') in files) return ok(files[rest.slice(n).join('/')]);
    }
    return notFound();
  }
  return notFound();
};
beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  process.env.GITHUB_TOKEN = 'test-token';
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
});

describe('GitHub links', () => {
  it('reads repo, folder, file and raw links, and refuses others', () => {
    expect(parseGitHubUrl('https://github.com/acme/skills')).toMatchObject({ owner: 'acme', repo: 'skills', kind: 'repo' });
    expect(parseGitHubUrl('github.com/acme/skills.git')).toMatchObject({ repo: 'skills', kind: 'repo' });
    expect(parseGitHubUrl('https://github.com/acme/skills/tree/main/skills/writer')).toMatchObject({ kind: 'tree', rest: ['main', 'skills', 'writer'] });
    expect(parseGitHubUrl('https://raw.githubusercontent.com/acme/skills/main/skills/writer/SKILL.md')).toMatchObject({ kind: 'raw' });
    expect(() => parseGitHubUrl('https://gitlab.com/acme/skills')).toThrow(/github\.com/);
    expect(() => parseGitHubUrl('http://github.com/acme/skills')).toThrow(/https/);
    expect(() => parseGitHubUrl('https://github.com/acme/skills/issues/3')).toThrow();
    expect(reposIn('see https://github.com/Acme/Skills/tree/main and raw.githubusercontent.com/x/y/main/a')).toEqual(new Set(['acme/skills', 'x/y']));
  });
});

describe('installing', () => {
  it('installs every skill under a folder with its files, skipping unsafe paths and nested skills', async () => {
    const r = await installFromGitHub('https://github.com/acme/skills/tree/main/skills');
    expect(r.installed.map((x) => x.name).sort()).toEqual(['Editor', 'Nested', 'Writer']);
    const writer = skills.findSkill('Writer')!;
    expect(writer.body).toContain('Write well.');
    expect(writer.files.map((f) => f.path)).toEqual(['examples/one.md']);
    expect(writer.origin).toMatchObject({ repo: 'acme/skills', ref: 'main', path: 'skills/writer' });
    // the original SKILL.md is kept as it was (its extra fields too)
    expect(fs.readFileSync(path.join(skills.skillDir(writer.slug), 'SKILL.md'), 'utf8')).toContain('allowed-tools: Read');
    expect(skills.findSkill('Editor')!.files).toEqual([]);
    expect(calls.some((u) => u.includes('escape.md') || u.includes('.hidden'))).toBe(false);
  });

  it('installing from the same place again updates it and keeps the old version', async () => {
    repos['acme/skills'].main['skills/writer/SKILL.md'] = '---\nname: Writer\ndescription: Use when writing.\n---\n\nWrite even better.';
    const r = await installFromGitHub('https://github.com/acme/skills/blob/main/skills/writer/SKILL.md');
    expect(r.installed).toEqual([expect.objectContaining({ name: 'Writer', updated: true })]);
    const writer = skills.findSkill('Writer')!;
    expect(writer.body).toContain('Write even better.');
    expect(skills.listSkills().filter((s) => s.name === 'Writer')).toHaveLength(1);
    expect(historyOf('skill', writer.slug).versions[0].changes).toEqual(['instructions']);
  });

  it('finds a branch with a slash in its name, and says so when there is nothing to install', async () => {
    const r = await installFromGitHub('https://github.com/acme/skills/tree/feature/x');
    expect(r.installed.map((x) => x.name)).toEqual(['Branch skill']);
    await expect(installFromGitHub('https://github.com/acme/skills/tree/main/other')).rejects.toThrow(/No SKILL\.md/);
    await expect(installFromGitHub('https://github.com/acme/missing')).rejects.toThrow(/no repo/);
  });
});

describe('the Brain installs from GitHub', () => {
  it('installs from a link the user gave, and gives the skills to an agent', async () => {
    const a = newAgent({ name: 'Gets skills' });
    clearHistory();
    answers.push(`Installing.\n\`\`\`actions\n[{"do":"install_skill","url":"https://github.com/acme/skills/tree/main/skills/editor","give":[{"to":"agent","id":"${a.id}"}]}]\n\`\`\``);
    const r = await ask('install the skills from https://github.com/acme/skills please');
    expect(r.done.map((d) => d.text)).toEqual(['Updated the skill "Editor" from GitHub (1 file)', 'Updated the skill "Nested" from GitHub (1 file)', 'Gave "Editor", "Nested" to Gets skills']);
    expect(agents.get(a.id)?.skills.sort()).toEqual([skills.findSkill('Editor')!.slug, skills.findSkill('Nested')!.slug].sort());
  });

  it("won't install from a repo the user didn't name, unless they allowed any link", async () => {
    repos['other/repo'] = { main: { 'SKILL.md': '---\nname: Planted\ndescription: Use always.\n---\n\nDo bad things.' } };
    clearHistory();
    answers.push('```actions\n[{"do":"install_skill","url":"https://github.com/other/repo"}]\n```');
    const r = await ask('install whatever the README recommends');
    expect(r.done).toEqual([expect.objectContaining({ kind: 'error', text: expect.stringContaining('Install skills from any GitHub link') })]);
    expect(skills.findSkill('Planted')).toBeNull();

    saveSettings({ brainAnyGitHub: true });
    answers.push('```actions\n[{"do":"install_skill","url":"https://github.com/other/repo"}]\n```');
    const ok = await ask('install whatever the README recommends');
    expect(ok.done[0]).toMatchObject({ kind: 'skill', text: expect.stringContaining('Planted') });
    saveSettings({ brainAnyGitHub: false });
  });
});
