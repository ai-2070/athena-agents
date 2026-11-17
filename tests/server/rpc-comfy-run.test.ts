// Running a ComfyUI workflow from the page: an empty prompt or negative is passed on as empty (it clears the text
// saved in the workflow), where one left out keeps that text (BH-122).
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const asked = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../server/comfyui.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/comfyui.ts')>()),
  runWorkflow: async (opts: Record<string, unknown>) => {
    asked.push(opts);
    return { promptId: 'p1', images: [], files: [] };
  },
}));

const { handleRpc } = await import('../../server/rpc.ts');
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const run = (body: unknown) =>
  fetch(`${base}/api/comfyui/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('running a ComfyUI workflow from the page', () => {
  it('passes an empty prompt on as empty, and one left out as left out', async () => {
    expect((await run({ workflow: 'portrait', prompt: '', negative: '' })).status).toBe(200);
    expect(asked.at(-1)).toMatchObject({ workflow: 'portrait', prompt: '', negative: '' });
    expect((await run({ workflow: 'portrait' })).status).toBe(200);
    expect(asked.at(-1)?.prompt).toBeUndefined();
    expect(asked.at(-1)?.negative).toBeUndefined();
  });
});
