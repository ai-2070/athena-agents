// A real Eve process and Athena bridge, with no user data or paid model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Client } from 'eve/client';

const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-eve-integration-'));
const home = path.join(temporary, 'home');
fs.mkdirSync(home);
process.env.DASH_DATA = path.join(temporary, 'data');
process.env.HOME = home;
process.env.USERPROFILE = home;
assert.equal(os.homedir(), home);

const { activeProject, agents, chats, saveSettings, setSecret } = await import('../server/store.ts');
const { newAgent } = await import('../server/library.ts');
const { beginRun, bindSession, readRun, setRunStatus } = await import('../server/eve/state.ts');
const { openEveBridge } = await import('../server/eve/bridge.ts');
const { startEveHost } = await import('../server/eve/host.ts');
const { projectEvent } = await import('../server/eve/projection.ts');
const { deliverApprovalDecisions, eveClient, reconcileSnapshot, recoverEveRuns, stopEveRun } = await import('../server/eve/recovery.ts');
const { decide, listApprovals } = await import('../server/approvals.ts');
const { answerQuestion, waitingQuestions } = await import('../server/questions.ts');
const { dataPath } = await import('../server/util.ts');
let requests = 0;
const model = http.createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const body: unknown = JSON.parse(text);
    assert(body && typeof body === 'object' && 'messages' in body && 'tools' in body);
    assert.equal(request.headers.authorization, 'Bearer integration-key');
    assert(Array.isArray(body.tools));
    const writing = JSON.stringify(body.messages).includes('DURABLE_WRITE_PROOF');
    const asking = JSON.stringify(body.messages).includes('DURABLE_QUESTION_PROOF');
    const toolName = writing ? 'write_file' : asking ? 'ask_user' : 'list_agents';
    const offered = body.tools.find((tool: unknown) => typeof tool === 'object' && tool !== null && 'function' in tool && typeof tool.function === 'object' && tool.function !== null && 'name' in tool.function && typeof tool.function.name === 'string' && tool.function.name.endsWith(toolName)) as { function: { name: string } } | undefined;
    assert(offered, 'The selected Athena tool must be available.');
    requests++;
    const completed = JSON.stringify(body.messages).includes(writing ? 'Wrote ' : asking ? 'The user answered' : 'Integration peer');
    const delta = completed ? { content: 'ATHENA_INTEGRATION_REPLY' }
      : { tool_calls: [{ index: 0, id: 'integration-call', type: 'function', function: { name: offered.function.name, arguments: writing ? '{"path":"approved.txt","content":"saved once"}' : asking ? '{"question":"Pick a colour","choices":["Blue","Red"]}' : '{}' } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  } catch {
    response.writeHead(500).end('The integration fixture received an unexpected request.');
  }
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const address = model.address();
assert(address && typeof address !== 'string');
const bridge = await openEveBridge();
let host: Awaited<ReturnType<typeof startEveHost>> | undefined;
try {
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${address.port}/v1`, label: 'Integration fixture' } }, compaction: { windowTokens: 64000 } });
  setSecret('customKey', 'integration-key');
  const project = activeProject();
  const agent = agents.save(newAgent({ name: 'Integration owner', provider: 'custom', model: 'integration-proof', toolGroups: ['agents'], mcpServers: [], richAnswers: false }));
  agents.save(newAgent({ name: 'Integration peer' }));
  const chat = chats.create(agent.id, 'Integration proof');
  const binding = bindSession(agent, chat, project, 'proof');
  beginRun('integration-run', binding.id);
  setRunStatus('integration-run', 'running');
  host = await startEveHost({ executable: process.execPath, entry: path.join(root, 'runtime/eve/.output/launch.mjs'), templates: path.join(root, 'runtime/eve/.eve/sandbox-cache'), directory: dataPath('runtime/eve/worker'), bridgeUrl: bridge.url, bridgeToken: bridge.token });
  const client = new Client({ baseUrl: host.url, auth: { bearer: host.token }, headers: { 'x-athena-binding': binding.id } });
  const { delivery } = await client.sessions.create({ message: 'List the other agents using the supplied tool.', signal: AbortSignal.timeout(30000) });
  setRunStatus('integration-run', 'running', delivery.deliveryId);
  for await (const event of delivery.stream({ signal: AbortSignal.timeout(30000) })) projectEvent('integration-run', event);
  const result = await delivery.result({ signal: AbortSignal.timeout(10000) });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.reply, 'ATHENA_INTEGRATION_REPLY');
  const recorded = readRun('integration-run');
  assert(recorded?.events.some((item) => item.event.kind === 'tool_result' && item.event.text?.includes('Integration peer')));
  assert(recorded?.events.some((item) => item.event.kind === 'text' && item.event.text === result.reply));
  assert.equal(requests, 2);
  assert(!JSON.stringify(recorded).includes('integration-key'));
  setRunStatus('integration-run', 'completed', delivery.deliveryId);
  console.log('eve integration: private Bun process, saved binding, Athena tool routing and replay-safe event projection ok');
  for (const kind of ['approval', 'question', 'stop'] as const) {
    console.log(`eve integration: testing ${kind} recovery`);
    const workspace = path.join(temporary, kind);
    fs.mkdirSync(workspace);
    const owner = agents.save(newAgent({ name: `Durable ${kind}`, provider: 'custom', model: 'integration-proof', toolGroups: ['files'], autonomy: 'ask', workspace, mcpServers: [], richAnswers: false }));
    const conversation = chats.create(owner.id, `Durable ${kind}`);
    const saved = bindSession(owner, conversation, project, 'proof');
    const runId = `durable-${kind}`;
    beginRun(runId, saved.id);
    setRunStatus(runId, 'running');
    const transport = eveClient(host, saved.id);
    const { session, delivery: pending } = await transport.sessions.create({ message: kind === 'question' ? 'DURABLE_QUESTION_PROOF' : 'DURABLE_WRITE_PROOF', signal: AbortSignal.timeout(30000) });
    setRunStatus(runId, 'running', pending.deliveryId);
    for await (const event of pending.stream({ signal: AbortSignal.timeout(30000) })) projectEvent(runId, event);
    console.log(`eve integration: ${kind} parked`);
    const paused = await session.snapshot({ signal: AbortSignal.timeout(10000) });
    reconcileSnapshot(runId, paused);
    assert.equal(readRun(runId)?.status, 'waiting');
    assert(!fs.existsSync(path.join(workspace, 'approved.txt')), 'No file may be written before consent.');
    if (kind === 'stop') await stopEveRun(runId);
    await host.close();
    host = await startEveHost({ executable: process.execPath, entry: path.join(root, 'runtime/eve/.output/launch.mjs'), templates: path.join(root, 'runtime/eve/.eve/sandbox-cache'), directory: dataPath('runtime/eve/worker'), bridgeUrl: bridge.url, bridgeToken: bridge.token });
    const resumed = eveClient(host, saved.id);
    await recoverEveRuns(host);
    console.log(`eve integration: ${kind} recovered`);
    if (kind === 'stop') {
      assert.equal(readRun(runId)?.status, 'stopped');
      assert(!fs.existsSync(path.join(workspace, 'approved.txt')));
      assert(!listApprovals().some((item) => item.data.runId === runId));
      continue;
    }
    if (kind === 'approval') {
      const request = listApprovals().find((item) => item.data.runId === runId);
      assert(request, 'The original Athena approval must survive restart.');
      assert(decide(request.id, { approved: true }));
    } else {
      const question = waitingQuestions().find((item) => item.runId === runId);
      assert(question, 'The original Outbox question must survive restart.');
      const answer = await answerQuestion(question.id, { choice: 'Blue' });
      assert.equal(answer.delivered, 'live', 'The answer must resume the original call without queuing another turn.');
    }
    await deliverApprovalDecisions(runId, resumed);
    console.log(`eve integration: ${kind} answer delivered`);
    for await (const event of resumed.sessions.attach(session.id, { streamIndex: paused.session.streamIndex }).stream({ signal: AbortSignal.timeout(30000) })) {
      projectEvent(runId, event);
      if (event.type === 'turn.settled' && event.data.turnId === readRun(runId)?.turnId) break;
    }
    reconcileSnapshot(runId, await resumed.sessions.attach(session.id).snapshot({ signal: AbortSignal.timeout(10000) }));
    assert.equal(readRun(runId)?.status, 'completed');
    assert.equal(readRun(runId)?.events.filter((item) => item.event.kind === 'tool').length, 1);
    assert.equal(readRun(runId)?.events.filter((item) => item.event.kind === 'tool_result').length, 1);
    if (kind === 'approval') assert.equal(fs.readFileSync(path.join(workspace, 'approved.txt'), 'utf8'), 'saved once');
  }
  assert.equal(requests, 7, 'Stopped work must not make another model call.');
  console.log('eve integration: approval and Outbox answer survive immediate restart; stopped work stays stopped');
} finally {
  await host?.close();
  await bridge.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  assert(temporary.startsWith(path.join(os.tmpdir(), 'athena-eve-integration-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}
