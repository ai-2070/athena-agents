// fetch_url reads pages as Markdown in parts (downloaded once), and await_agent waits for several helpers at once.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool } from '../../server/tools.ts';
import { htmlToMarkdown, forgetPages } from '../../server/webread.ts';
import { awaitHandoffs } from '../../server/handoffs.ts';
import { saveHandoff } from '../../server/execution.ts';
import { activeProject } from '../../server/store.ts';

let server: http.Server;
let hits = 0;
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const reader = { id: 'reader', name: 'Reader', toolGroups: ['browser'] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/long')
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`${'x'.repeat(30_000)}THE-END`);
    if (req.url === '/pic')
      return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50]));
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        '<html><head><title>Hi &amp; bye</title><script>evil()</script></head><body><nav>Menu</nav><h1>Big</h1><p>See <a href="/docs">the docs</a>.</p><pre>  keep   spacing</pre><footer>Legal</footer></body></html>',
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('htmlToMarkdown', () => {
  it('keeps headings, links and code, and leaves out scripts, menus and footers', () => {
    const md = htmlToMarkdown(
      '<title>T</title><nav>Menu</nav><h2>Part</h2><ul><li>one</li><li>two</li></ul><p>A <a href="/x">link</a> &amp; <code>code</code>&#33;</p><pre>a\n  b</pre><script>x()</script><footer>F</footer>',
      'https://example.com/page',
    );
    expect(md).toContain('Title: T');
    expect(md).toContain('## Part');
    expect(md).toContain('- one\n- two');
    expect(md).toContain('A [link](https://example.com/x) & `code`!');
    expect(md).toContain('```\na\n  b\n```');
    expect(md).not.toMatch(/Menu|x\(\)|\bF\b/);
  });
});

describe('fetch_url', () => {
  it('returns a page as Markdown', async () => {
    const r = (await callTool(reader, 'fetch_url', { url: `${base()}/` })).text;
    expect(r).toMatch(/^HTTP 200 /);
    expect(r).toContain('Title: Hi & bye');
    expect(r).toContain('# Big');
    expect(r).toContain(`[the docs](${base()}/docs)`);
    expect(r).not.toContain('evil');
  });

  it('reads a long page in parts, downloading it once', async () => {
    forgetPages();
    hits = 0;
    const first = (await callTool(reader, 'fetch_url', { url: `${base()}/long` })).text;
    expect(first).toMatch(/Continue with offset 20000\./);
    expect(first).not.toContain('THE-END');
    const next = (await callTool(reader, 'fetch_url', { url: `${base()}/long`, offset: 20000 })).text;
    expect(next).toContain('THE-END');
    expect(hits).toBe(1);
  });

  it('caps a part, and says when a link is not text', async () => {
    const r = (await callTool(reader, 'fetch_url', { url: `${base()}/long`, max_chars: 10_000_000 })).text;
    expect(r).toContain('THE-END');
    expect((await callTool(reader, 'fetch_url', { url: `${base()}/pic` })).text).toMatch(/image\/png file, not text/);
  });
});

describe('await_agent with several handles', () => {
  const handoff = (id: string, done: boolean) =>
    saveHandoff({
      id,
      from: 'boss',
      projectId: activeProject().id,
      to: 'helper',
      toName: `Helper ${id}`,
      chatId: `c-${id}`,
      runId: `r-${id}`,
      task: 'work',
      startedAt: Date.now() - 1000,
      ...(done ? { answer: `answer ${id}`, endedAt: Date.now() } : {}),
    });

  it('returns as soon as one is done, and says which are still working', async () => {
    handoff('h-done', true);
    handoff('h-busy', false);
    const r = await awaitHandoffs(['h-done', 'h-busy'], 'boss', { waitS: 30 });
    expect(r.text).toContain('[h-done] Helper h-done says:\nanswer h-done');
    expect(r.text).toContain('[h-busy] Helper h-busy is still working');
    expect(r.text).toContain('call await_agent again with handles ["h-busy"]');
  });

  it('with all, waits for every one (here: until the wait runs out)', async () => {
    const started = Date.now();
    const r = await awaitHandoffs(['h-done', 'h-busy'], 'boss', { all: true, waitS: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(r.text).toContain('Still working');
  });

  it("refuses a handle that isn't there or belongs to someone else", async () => {
    expect((await awaitHandoffs(['h-done', 'nope'], 'boss')).text).toMatch(/No handoff with handle nope/);
    expect((await awaitHandoffs(['h-done', 'h-busy'], 'someone-else')).text).toMatch(/belongs to another agent/);
  });
});
