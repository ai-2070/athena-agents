// Athena's skills (skills/athena) replace the copies of Hermes Agent's skills. Its README.md has the standard each one
// follows; these checks catch what can be caught mechanically. Whether the writing is good is for review.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shippedSkillSlugs } from '../../server/skills.ts';
import { ROOT, parseFrontmatter } from '../../server/util.ts';

const dir = path.join(ROOT, 'skills', 'athena');
const testsDir = path.join(ROOT, 'tests', 'skills');
const replaced = JSON.parse(fs.readFileSync(path.join(dir, 'replaced.json'), 'utf8')) as { skills: Record<string, { now: string | null; path: string }> };
const planned = [...new Set(Object.values(replaced.skills).flatMap((s) => (s.now ? [s.now] : [])))].sort();
const ids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/** Every file in a skill's folder, as a path relative to it with forward slashes. Python's caches from running a
 *  script by hand don't count (git ignores them, so they never ship). */
function filesOf(id: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, id, ...rel.split('/').filter(Boolean)), { withFileTypes: true }).flatMap((e) => {
    const at = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === '__pycache__') return [];
    return e.isDirectory() ? filesOf(id, at) : [at];
  });
}
const read = (id: string, rel: string) => fs.readFileSync(path.join(dir, id, ...rel.split('/')), 'utf8');
const markdown = (id: string) => filesOf(id).filter((f) => f.endsWith('.md'));
// the prose of a Markdown file, without code blocks and inline code
const prose = (text: string) => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');

// Hermes's own tools, which other agents don't have, and where Hermes keeps things
const HERMES_TOOL = /\b(?:terminal|execute_code|web_extract|web_search|search_files|read_file|write_file|patch|delegate_task|vision_analyze|skill_view|skill_manage|browser_exec|browser_navigate|clarify|cronjob_manage)\(|`(?:execute_code|web_extract|search_files|read_file|write_file|delegate_task|vision_analyze|skill_view|skill_manage|browser_exec|browser_navigate|clarify|cronjob_manage)`/;
const HERMES_PATH = /~\/\.hermes|\$\{?HERMES_|HERMES_SKILL_DIR|Hermes Agent\b|HermesAgent\//;
// skills the old ones pointed at that don't ship (programs of the same name, like himalaya and mcporter, are fine)
const GONE = ['excel-author', 'dcf-model', 'lbo-model', '3-statement-model', 'comps-analysis', 'merger-model', 'email-inbox-triage', 'meeting-action-items', 'document-to-action-items', 'one-three-one-rule', 'decision-questionnaire', 'architecture-diagram', 'reddit-reading', 'duckduckgo-search', 'airtable', 'ascii-video', 'blocked-page-recovery', 'blogwatcher', 'claude-design', 'codebase-inspection', 'competitor-news-monitor', 'google-workspace', 'hermes-agent', 'meme-generation', 'popular-web-designs', 'pptx-author', 'simplify-code', 'songwriting-and-ai-music', 'stable-diffusion', 'subagent-driven-development', 'teams-meeting-pipeline', 'github-auth', 'github-pr-workflow', 'ocr-and-documents', 'latex-pdf-report', 'native-mcp', 'gsd-spike', 'gsd-sketch'];

const hermes = path.join(ROOT, 'skills', 'hermes');
// runs of 10 words of prose, ignoring case and punctuation: long enough that a shared one was copied (code that names
// the same commands and APIs is left out)
function runs(text: string): Set<string> {
  const words = prose(text).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
  const out = new Set<string>();
  for (let i = 0; i + 10 <= words.length; i++) out.add(words.slice(i, i + 10).join(' '));
  return out;
}
const mdUnder = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? mdUnder(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []));
const scriptsOf = (id: string) => filesOf(id).filter((f) => /^scripts\/.+\.(?:py|mjs|js|ts)$/.test(f));

describe("Athena's skills", () => {
  it('records where each of the 51 Hermes skills went, and the README says so', () => {
    expect(Object.keys(replaced.skills)).toHaveLength(51);
    expect(planned).toHaveLength(39);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    for (const old of Object.keys(replaced.skills)) expect(readme, old).toContain(`\`${old}\``);
  });

  it('has a folder only for the planned ids, and test folders only for its skills', () => {
    for (const id of ids) expect(planned, id).toContain(id);
    if (!fs.existsSync(testsDir)) return;
    for (const e of fs.readdirSync(testsDir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '__pycache__') expect(ids, `tests/skills/${e.name}`).toContain(e.name);
    }
  });

  it('keeps a helper several skills share identical in each', () => {
    const byName = new Map<string, { id: string; text: string }[]>();
    for (const id of ids) for (const f of scriptsOf(id)) byName.set(path.posix.basename(f), [...(byName.get(path.posix.basename(f)) || []), { id, text: read(id, f) }]);
    for (const [name, copies] of byName) {
      for (const c of copies.slice(1)) expect(c.text === copies[0].text, `${name} differs between ${copies[0].id} and ${c.id}`).toBe(true);
    }
  });
});

// one set per skill, so a problem in one doesn't hide the others'
describe.each(ids)('the skill %s', (id) => {
  it('has a name and a description an agent can choose from', () => {
    const { meta } = parseFrontmatter(read(id, 'SKILL.md'));
    expect(Object.keys(meta).sort(), 'frontmatter keys').toEqual(['description', 'name']);
    expect(meta.name.length, 'name').toBeGreaterThan(2);
    expect(meta.name.length, 'name').toBeLessThanOrEqual(40);
    expect(meta.name, 'name').not.toMatch(/\.$/);
    expect(meta.description.length, `description is ${meta.description.length} characters`).toBeGreaterThanOrEqual(60);
    expect(meta.description.length, `description is ${meta.description.length} characters`).toBeLessThanOrEqual(300);
  });

  it('keeps SKILL.md short enough to read on every use, and names every other file', () => {
    const lines = read(id, 'SKILL.md').split(/\r?\n/).length;
    expect(lines, `SKILL.md is ${lines} lines`).toBeGreaterThanOrEqual(40);
    expect(lines, `SKILL.md is ${lines} lines`).toBeLessThanOrEqual(250);
    // a file counts as named when SKILL.md, or a Markdown file it names, mentions its path
    const files = filesOf(id);
    const named = new Set(['SKILL.md']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of files) {
        if (named.has(f)) continue;
        const by = [...named].filter((n) => n.endsWith('.md')).some((n) => {
          const text = read(id, n);
          return text.includes(f) || text.includes(path.posix.relative(path.posix.dirname(n), f));
        });
        if (by) {
          named.add(f);
          grew = true;
        }
      }
    }
    for (const f of files) expect(named.has(f), `nothing names ${f}`).toBe(true);
  });

  it('carries no shell scripts, tests or build leftovers', () => {
    for (const f of filesOf(id)) {
      expect(f).not.toMatch(/\.(?:sh|bash|pyc)$/);
      expect(f).not.toMatch(/(?:^|\/)(?:tests?|node_modules|\.pytest_cache)\//);
    }
  });

  it("names no other agent's tools, no Hermes paths and no skills that don't ship", () => {
    const shipped = new Set([...shippedSkillSlugs(), ...ids]);
    for (const f of filesOf(id)) {
      if (/\.(?:png|jpe?g|gif|webp|ico|pdf|xlsx|docx|pptx)$/.test(f)) continue;
      const text = read(id, f);
      expect(text, `${f}: a Hermes path`).not.toMatch(HERMES_PATH);
      if (!f.endsWith('.md')) continue;
      expect(text, `${f}: a Hermes tool`).not.toMatch(HERMES_TOOL);
      for (const gone of GONE) expect(text, `${f}: names the skill ${gone}, which doesn't ship`).not.toContain(`\`${gone}\``);
      // a planned skill that isn't written yet doesn't ship either
      for (const later of planned.filter((p) => !ids.includes(p))) expect(text, `${f}: names ${later}, which isn't written yet`).not.toContain(`\`${later}\``);
      // ids written as `read_skill name="…"` must exist
      for (const m of text.matchAll(/read_skill\s+name="([^"]+)"/g)) expect(shipped.has(m[1]), `${f}: no skill ${m[1]}`).toBe(true);
    }
  });

  it('is written as judgment, not the old template', () => {
    for (const f of markdown(id)) {
      const text = prose(read(id, f));
      expect(text, `${f}: shouting`).not.toMatch(/\b(?:MUST|NEVER|ALWAYS|MANDATORY|NON-NEGOTIABLE|CRITICAL|IMPORTANT|HARD-GATE)\b/);
      expect(text, f).not.toMatch(/Iron Law|violating the letter/i);
      // what an agent can do comes from its tools at run time
      expect(text, `${f}: states the model's limits`).not.toMatch(/\byou (?:cannot|can't|are unable to|are not able to) (?:see|view|browse|run code|execute|access the internet|open files)\b|\bif your model (?:cannot|can't|doesn't|does not)\b|\bnon-vision models?\b/i);
    }
    // the Skills page shows the name; a title heading above the opening paragraph only repeats it
    const body = parseFrontmatter(read(id, 'SKILL.md')).body;
    expect(body.replace(/^(```|~~~)[\s\S]*?^\1/gm, ''), 'a title heading').not.toMatch(/^# /m);
  });

  it('copies no text from the Hermes skill it replaces', () => {
    if (!fs.existsSync(hermes)) return;
    const old = new Set<string>();
    for (const s of Object.values(replaced.skills).filter((x) => x.now === id)) {
      for (const f of mdUnder(path.join(hermes, ...s.path.split('/')))) for (const r of runs(fs.readFileSync(f, 'utf8'))) old.add(r);
    }
    for (const f of markdown(id)) expect([...runs(read(id, f))].filter((r) => old.has(r)), `${f}: words copied from the old skill`).toEqual([]);
  });

  it('has tests for its scripts', () => {
    if (!scriptsOf(id).length) return;
    const t = path.join(testsDir, id);
    const tests = fs.existsSync(t) ? fs.readdirSync(t).filter((f) => /^test_.+\.py$/.test(f)) : [];
    expect(tests.length, `scripts with no tests in tests/skills/${id}`).toBeGreaterThan(0);
  });
});
