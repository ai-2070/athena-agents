// The Brain on OpenRouter runs on the real Eve engine (a fake model server here). The Brain is made for each turn
// and never saved with the other agents, yet Eve looks its agent up by id: it must find it, or every answer is
// "(no answer)". And a turn that fails says what went wrong instead of "(no answer)".
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ base: '', calls: 0, refuse: false }));
// (OpenRouter's address is fixed: it is pointed at the fake server)
vi.mock('../../server/apiproviders.ts', async (orig) => {
  const real = await orig<typeof import('../../server/apiproviders.ts')>();
  return {
    ...real,
    resolveApiProvider: (id: string) =>
      id === 'openrouter'
        ? {
            id: 'openrouter',
            label: 'OpenRouter',
            base: fake.base,
            headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
          }
        : real.resolveApiProvider(id),
  };
});

const { ask, clearHistory } = await import('../../server/overseer.ts');
const { saveSettings, setSecret } = await import('../../server/store.ts');

let server: http.Server;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    for await (const _ of req) {
      /* read it all */
    }
    fake.calls++;
    if (fake.refuse) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Authentication failed' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello from the Brain.' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  setSecret('openrouterKey', 'test');
  saveSettings({ brain: { provider: 'openrouter', model: 'mock' } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the Brain on Eve', () => {
  it('answers', async () => {
    const r = await ask('hello');
    expect(r.answer).toBe('Hello from the Brain.');
    expect(fake.calls).toBe(1);
  }, 60_000);

  it('says what went wrong when its turn fails', async () => {
    clearHistory();
    fake.refuse = true;
    try {
      // (it did nothing before it failed: the chat shows the error, as for any other)
      await expect(ask('hello again')).rejects.toThrow(/Authentication failed/);
    } finally {
      fake.refuse = false;
    }
  }, 60_000);
});
