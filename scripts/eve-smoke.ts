// Exercise only a staged runtime, a fake provider and a fake authenticated tool bridge.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from 'eve/client';
import type { ChildProcess } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.resolve(process.argv[2] || path.join(root, 'runtime/eve/.output/server/index.mjs'));
const executable = process.argv[3] || process.execPath;
const sandboxTemplates = process.argv[4] || path.join(root, 'runtime/eve/.eve/sandbox-cache');
if (!fs.existsSync(entry)) throw new Error('Build the Eve runtime before running its smoke check.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-eve-smoke-'));
fs.cpSync(sandboxTemplates, path.join(temporary, '.eve', 'sandbox-cache'), { recursive: true });
const token = crypto.randomBytes(32).toString('hex');
const bridgeToken = crypto.randomBytes(32).toString('hex');
const binding = crypto.randomBytes(16).toString('hex');
const observations: { model: string; messages: unknown; tools?: { function: { name: string } }[] }[] = [];
let toolCalls = 0;
let output = '';
let child: ChildProcess | undefined;

const fixture = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(body && typeof body === 'object');
    if (req.url === '/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer fixture-provider-key');
      assert('model' in body && 'messages' in body);
      const request = body as typeof observations[number];
      observations.push(request);
      const seenToolResult = JSON.stringify(request.messages).includes('ATHENA_TOOL_RESULT');
      const tool = request.tools?.find((item) => item.function.name.includes('probe'));
      assert(tool, 'Only the allowed Athena tool should be offered.');
      assert.equal(request.tools?.length, 1, 'Eve default tools must be disabled.');
      const delta = seenToolResult
        ? { content: 'ATHENA_EVE_REPLY' }
        : { tool_calls: [{ index: 0, id: 'probe-call', type: 'function', function: { name: tool.function.name, arguments: '{"value":"proof"}' } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: {}, finish_reason: seenToolResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${bridgeToken}`);
    assert('binding' in body && body.binding === binding);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/configuration') {
      res.end(JSON.stringify({ runId: 'smoke-run', model: 'athena-proof', baseUrl: `${fixtureUrl}/v1`, apiKey: 'fixture-provider-key', instructions: 'ATHENA_DYNAMIC_INSTRUCTIONS', contextWindow: 64000, tools: [{ name: 'probe', description: 'Read the proof value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] }));
    } else if (req.url === '/policy') {
      res.end(JSON.stringify({ status: 'approved' }));
    } else {
      assert.equal(req.url, '/tool');
      assert('input' in body);
      assert(body.input && typeof body.input === 'object' && 'sessionId' in body.input && typeof body.input.sessionId === 'string');
      assert('callId' in body.input && typeof body.input.callId === 'string');
      assert('name' in body.input && body.input.name === 'probe');
      assert('args' in body.input);
      assert.deepEqual(body.input.args, { value: 'proof' });
      toolCalls++;
      res.end(JSON.stringify({ text: 'ATHENA_TOOL_RESULT' }));
    }
  } catch (error) {
    res.writeHead(500);
    res.end(error instanceof Error ? error.message : String(error));
  }
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const fixtureAddress = fixture.address();
assert(fixtureAddress && typeof fixtureAddress !== 'string');
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}`;
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const runtimeAddress = listener.address();
assert(runtimeAddress && typeof runtimeAddress !== 'string');
const runtimePort = runtimeAddress.port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const runtimeUrl = `http://127.0.0.1:${runtimePort}`;

async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill();
  await stopped;
}

async function start() {
  child = spawn(executable, [entry], {
    cwd: temporary,
    windowsHide: true,
    env: {
      ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: String(runtimePort), NITRO_PORT: String(runtimePort),
      HOME: temporary, USERPROFILE: temporary, DASH_DATA: temporary,
      WORKFLOW_LOCAL_DATA_DIR: path.join(temporary, 'workflow'), WORKFLOW_LOCAL_BASE_URL: runtimeUrl,
      WORKFLOW_INLINE_OWNERSHIP: '0',
      ATHENA_EVE_TOKEN: token, ATHENA_EVE_BRIDGE_TOKEN: bridgeToken, ATHENA_EVE_BRIDGE_URL: fixtureUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Eve exited: ${output}`);
    try {
      if ((await fetch(`${runtimeUrl}/eve/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* wait for the private server */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Eve did not start: ${output}`);
}

try {
  const started = performance.now();
  await start();
  console.log(`eve smoke: private runtime ready in ${Math.round(performance.now() - started)} ms`);
  const refused = await fetch(`${runtimeUrl}/eve/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'unauthorized' }) });
  assert.equal(refused.status, 401);
  assert.equal(observations.length, 0);
  const client = new Client({ baseUrl: runtimeUrl, auth: { bearer: token }, headers: { 'x-athena-binding': binding } });
  const { session, delivery } = await client.sessions.create({ message: 'Use the proof tool.' });
  const result = await delivery.result({ signal: AbortSignal.timeout(30000) });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.reply, 'ATHENA_EVE_REPLY');
  assert.equal(toolCalls, 1);
  assert(JSON.stringify(observations[0]?.messages).includes('ATHENA_DYNAMIC_INSTRUCTIONS'));
  console.log('eve smoke: authentication, dynamic model/instructions and gated bridge round trip ok');
  const saved = session.state;
  // Delivery settlement precedes its Workflow checkpoint. Test an idle restart here;
  // interruption between those boundaries is a separate recovery case.
  const checkpointDeadline = Date.now() + 5000;
  for (; !process.argv.includes('--interrupt-after-reply');) {
    const stepFiles = fs.readdirSync(path.join(temporary, '.eve', '.workflow-data', 'steps'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.json'));
    const running = stepFiles.some((file) => {
      const step: unknown = JSON.parse(fs.readFileSync(path.join(temporary, '.eve', '.workflow-data', 'steps', file), 'utf8'));
      return typeof step === 'object' && step !== null && 'status' in step && step.status === 'running';
    });
    if (!running) break;
    assert(Date.now() < checkpointDeadline, 'The first turn must finish checkpointing.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stop();
  await start();
  console.log('eve smoke: runtime restarted, sending follow-up');
  const attached = client.sessions.attach(saved.sessionId, { streamIndex: saved.streamIndex });
  const response = await attached.send('Continue after restart.');
  const resumed = await response.result({ signal: AbortSignal.timeout(45000) });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.reply, 'ATHENA_EVE_REPLY');
  assert.equal(toolCalls, 1);
  console.log('eve smoke: saved session survives runtime restart');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
  const media = await attached.send([
    { type: 'text', text: 'Inspect the attached image and document.' },
    { type: 'file', data: `data:image/png;base64,${png}`, mediaType: 'image/png', filename: 'proof.png' },
    { type: 'file', data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64')}`, mediaType: 'application/pdf', filename: 'proof.pdf' },
  ]);
  const mediaResult = await media.result({ signal: AbortSignal.timeout(30000) });
  assert.equal(mediaResult.status, 'completed', JSON.stringify(mediaResult));
  const modelInput = JSON.stringify(observations.at(-1)?.messages);
  assert(modelInput.includes(png), 'The image bytes must reach the model.');
  assert(modelInput.includes('application/pdf'), 'The document must reach the model.');
  assert(fs.readdirSync(path.join(temporary, '.eve', '.workflow-data')).length > 0);
  console.log('eve smoke: image and PDF input without Docker, private writable workflow storage ok');
} catch (error) {
  console.error(`eve smoke: observed ${observations.length} model calls and ${toolCalls} tool calls`);
  console.error(output.slice(-8000));
  throw error;
} finally {
  await stop();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  // Only the absolute directory returned by mkdtemp is removed.
  assert(temporary.startsWith(path.join(os.tmpdir(), 'athena-eve-smoke-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}
