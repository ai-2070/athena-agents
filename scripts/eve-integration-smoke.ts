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

const { activeProject, agents, chats, workflows, saveSettings, setSecret } = await import('../server/store.ts');
const { newAgent } = await import('../server/library.ts');
const { beginRun, bindSession, readBinding, readRun, setRunStatus } = await import('../server/eve/state.ts');
const { prepareAdmission, readAdmission, submitAdmission } = await import('../server/eve/admission.ts');
const { eveUsage } = await import('../server/eve/usage.ts');
const { newBatch } = await import('../server/uploads.ts');
const { openEveBridge } = await import('../server/eve/bridge.ts');
const { startEveHost } = await import('../server/eve/host.ts');
const { projectEvent } = await import('../server/eve/projection.ts');
const { deliverApprovalDecisions, eveClient, prepareEveRecovery, reconcileSnapshot, recoverEveRuns, stopEveRun } = await import('../server/eve/recovery.ts');
const { EveRuntime } = await import('../server/eve/runtime.ts');
const { claimEveRuntime } = await import('../server/eve/ownership.ts');
const { EveCoordinator, eveConnection } = await import('../server/eve/coordinator.ts');
const { admitExecution, updateExecution } = await import('../server/execution.ts');
const { activeRuns, isChatBusy, nativeRunPromise, onRunEnd, recoverExecution } = await import('../server/engines/index.ts');
const { recoverTeamWork, teamMessages, teamState } = await import('../server/teams.ts');
const { saveTeamWork } = await import('../server/teamwork.ts');
const { decide, listApprovals } = await import('../server/approvals.ts');
const { answerQuestion, waitingQuestions } = await import('../server/questions.ts');
const { dataPath, readJSON, writeJSON } = await import('../server/util.ts');
const { callTool } = await import('../server/tools.ts');
const { shownWorld } = await import('../server/voxel/link.ts');
const { setOpenPages } = await import('../server/voxel/look.ts');
setOpenPages(() => 0);
let requests = 0;
let releaseLifecycle = () => {};
let lifecycleWaiting = 0;
const admittedMessages: unknown[] = [];
const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
const model = http.createServer(async (request, response) => {
  try {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const body: unknown = JSON.parse(text);
    assert(body && typeof body === 'object' && 'messages' in body && 'tools' in body);
    assert.equal(request.headers.authorization, 'Bearer integration-key');
    assert(Array.isArray(body.tools));
    if (JSON.stringify(body.messages).includes('ADMISSION_PROOF')) {
      assert('temperature' in body && body.temperature === 0);
      assert('reasoning_effort' in body && body.reasoning_effort === 'high');
      requests++;
      admittedMessages.push(body.messages);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ADMISSION_REPLY' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.01, prompt_tokens_details: { cached_tokens: 40 } } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const writing = JSON.stringify(body.messages).includes('DURABLE_WRITE_PROOF');
    const asking = JSON.stringify(body.messages).includes('DURABLE_QUESTION_PROOF');
    const granting = JSON.stringify(body.messages).includes('DURABLE_ACCESS_PROOF');
    const building = JSON.stringify(body.messages).includes('DURABLE_OWNER_PROOF');
    const looking = JSON.stringify(body.messages).includes('DURABLE_LOOK_PROOF');
    const toolName = writing ? 'write_file' : asking ? 'ask_user' : granting ? 'request_tool' : building ? 'world_build' : looking ? 'world_look' : 'list_agents';
    const offered = body.tools.find((tool: unknown) => typeof tool === 'object' && tool !== null && 'function' in tool && typeof tool.function === 'object' && tool.function !== null && 'name' in tool.function && typeof tool.function.name === 'string' && tool.function.name.endsWith(toolName)) as { function: { name: string } } | undefined;
    assert(offered, 'The selected Athena tool must be available.');
    requests++;
    const completed = Array.isArray(body.messages) && body.messages.some((message: unknown) => !!message && typeof message === 'object' && 'role' in message && message.role === 'tool');
    if (completed && JSON.stringify(body.messages).includes('DURABLE_LIFECYCLE_PROOF')) {
      lifecycleWaiting++;
      await lifecycleGate;
    }
    const args = writing ? { path: 'approved.txt', content: 'saved once' } : asking ? { question: 'Pick a colour', choices: ['Blue', 'Red'] }
      : granting ? { tools: 'shell', why: 'Run the requested build' }
        : building ? { object: 'Shared integration bench', steps: [{ box: [2, 2, 2], use: 'stone' }] } : {};
    const delta = completed ? { content: 'ATHENA_INTEGRATION_REPLY' }
      : { tool_calls: [{ index: 0, id: 'integration-call', type: 'function', function: { name: offered.function.name, arguments: JSON.stringify(args) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.01, prompt_tokens_details: { cached_tokens: 40 } } })}\n\ndata: [DONE]\n\n`);
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
let runtime: InstanceType<typeof EveRuntime> | undefined;
let coordinator: InstanceType<typeof EveCoordinator> | undefined;
async function startRuntime() {
  runtime = new EveRuntime({
    claim: claimEveRuntime,
    bridge: async () => ({ ...bridge, close: async () => {} }),
    host: (privateBridge, signal) => startEveHost({ executable: process.execPath, entry: path.join(root, 'runtime/eve/.output/launch.mjs'), templates: path.join(root, 'runtime/eve/.eve/sandbox-cache'), directory: dataPath('runtime/eve/worker'), bridgeUrl: privateBridge.url, bridgeToken: privateBridge.token, signal }),
    prepare: prepareEveRecovery, recover: recoverEveRuns, hasWork: () => false,
  });
  return runtime.ready();
}
try {
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${address.port}/v1`, label: 'Integration fixture' } }, contextWindowTokens: 64000 });
  setSecret('customKey', 'integration-key');
  const project = activeProject();
  const agent = agents.save(newAgent({ engine: 'eve', name: 'Integration owner', provider: 'custom', model: 'integration-proof', toolGroups: ['agents'], mcpServers: [], richAnswers: false }));
  agents.save(newAgent({ engine: 'eve', name: 'Integration peer' }));
  const chat = chats.create(agent.id, 'Integration proof');
  const binding = bindSession(agent, chat, project, 'proof');
  host = await startRuntime();
  beginRun('integration-run', binding.id);
  setRunStatus('integration-run', 'running');
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
  for (const kind of ['approval', 'question', 'access', 'ownership', 'look', 'stop'] as const) {
    console.log(`eve integration: testing ${kind} recovery`);
    const workspace = path.join(temporary, kind);
    fs.mkdirSync(workspace);
    const owner = agents.save(newAgent({ engine: 'eve', name: `Durable ${kind}`, provider: 'custom', model: 'integration-proof', toolGroups: kind === 'ownership' || kind === 'look' ? ['world'] : ['files'], autonomy: kind === 'access' || kind === 'look' ? 'full' : 'ask', workspace, mcpServers: [], richAnswers: false }));
    saveSettings({ brainApproves: false });
    if (kind === 'ownership') {
      const builder = newAgent({ engine: 'eve', name: 'Original integration builder', toolGroups: ['world'], autonomy: 'full' });
      assert.equal((await callTool(builder, 'world_build', { object: 'Shared integration bench', steps: [{ box: [1, 1, 1], use: 'wood' }] })).isError, false);
    }
    if (kind === 'look') saveSettings({ look: { stationLook: 'classic' } });
    const conversation = chats.create(owner.id, `Durable ${kind}`);
    const saved = bindSession(owner, conversation, project, 'proof');
    const runId = `durable-${kind}`;
    beginRun(runId, saved.id);
    setRunStatus(runId, 'running');
    const transport = eveClient(host, saved.id);
    const prompt = { approval: 'DURABLE_WRITE_PROOF', question: 'DURABLE_QUESTION_PROOF', access: 'DURABLE_ACCESS_PROOF', ownership: 'DURABLE_OWNER_PROOF', look: 'DURABLE_LOOK_PROOF', stop: 'DURABLE_WRITE_PROOF' }[kind];
    const { session, delivery: pending } = await transport.sessions.create({ message: prompt, signal: AbortSignal.timeout(30000) });
    setRunStatus(runId, 'running', pending.deliveryId);
    for await (const event of pending.stream({ signal: AbortSignal.timeout(30000) })) projectEvent(runId, event);
    console.log(`eve integration: ${kind} parked`);
    const paused = await session.snapshot({ signal: AbortSignal.timeout(10000) });
    reconcileSnapshot(runId, paused);
    assert.equal(readRun(runId)?.status, 'waiting');
    assert(!fs.existsSync(path.join(workspace, 'approved.txt')), 'No file may be written before consent.');
    if (kind === 'access') assert(!agents.get(owner.id)?.toolGroups.includes('shell'));
    if (kind === 'stop') await stopEveRun(runId);
    await runtime!.close();
    host = await startRuntime();
    const resumed = eveClient(host, saved.id);
    console.log(`eve integration: ${kind} recovered`);
    if (kind === 'stop') {
      assert.equal(readRun(runId)?.status, 'stopped');
      assert(!fs.existsSync(path.join(workspace, 'approved.txt')));
      assert(!listApprovals().some((item) => item.data.runId === runId));
      continue;
    }
    if (kind !== 'question') {
      const request = listApprovals().find((item) => item.data.runId === runId);
      assert(request, 'The original Athena approval must survive restart.');
      if (kind === 'access') assert.equal(request.kind, 'tools');
      if (kind === 'look') assert.equal(request.kind, 'setting');
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
    if (kind === 'access') assert(agents.get(owner.id)?.toolGroups.includes('shell'));
    if (kind === 'ownership') assert.equal(shownWorld().world?.objects.find((item) => item.name === 'Shared integration bench')?.volumes.reduce((sum, volume) => sum + volume.count, 0), 8);
    if (kind === 'look') {
      const { getSettings } = await import('../server/store.ts');
      assert.equal(getSettings().look.stationLook, 'world');
    }
  }
  assert.equal(requests, 13, 'Stopped work must not make another model call.');
  console.log('eve integration: tool, access, ownership, setting and Outbox waits survive immediate restart; stopped work stays stopped');
  const owner = agents.save(newAgent({ engine: 'eve', name: 'Lifecycle owner', provider: 'custom', model: 'integration-proof', toolGroups: ['agents'], richAnswers: false }));
  const team = workflows.save({ name: 'Lifecycle team', members: [owner.id], lead: owner.id, steps: [] });
  const conversation = chats.create(owner.id, 'Native lifecycle', team.id);
  const saved = bindSession(owner, conversation, project, 'proof');
  const runId = 'lifecycle-run';
  const parent = `team:${project.id}/${team.id}`;
  const threadFile = dataPath('projects', project.id, 'teamchats', `${team.id}.json`);
  writeJSON(threadFile, { messages: [{ id: 'native-team-source', from: 'user', text: 'DURABLE_LIFECYCLE_PROOF', ts: Date.now(), mentions: [owner.id] }], sessions: { [owner.id]: conversation.id }, seen: { [owner.id]: 0 }, filesSent: {} });
  saveTeamWork({ projectId: project.id, teamId: team.id, current: [{ agentId: owner.id, msgIds: ['native-team-source'], skills: [], returning: false, delivery: { runId, chatId: conversation.id, from: 0, readUpto: 1, files: [] } }], queue: [], interrupted: [], held: [], pending: [], assigned: [JSON.stringify([owner.id, 'native-team-source'])], brain: [], episode: { turns: 1 }, stopped: false, epoch: 0 });
  admitExecution({ id: runId, projectId: project.id, agentId: owner.id, chatId: conversation.id, engine: owner.engine, parentRunId: parent, ownerChatId: conversation.id, ownerAgentId: owner.id, depth: 1, text: 'DURABLE_LIFECYCLE_PROOF', from: null, attachments: [], startedAt: Date.now(), status: 'running' });
  beginRun(runId, saved.id, 1, parent);
  setRunStatus(runId, 'running');
  const { delivery: lifecycleDelivery } = await eveClient(host, saved.id).sessions.create({ message: 'DURABLE_LIFECYCLE_PROOF', signal: AbortSignal.timeout(30000) });
  setRunStatus(runId, 'running', lifecycleDelivery.deliveryId);
  for await (const event of lifecycleDelivery.stream({ signal: AbortSignal.timeout(30000) })) {
    projectEvent(runId, event);
    if (event.type === 'call.settled') break;
  }
  coordinator = new EveCoordinator({ ready: () => runtime!.ready(), connect: eveConnection, retryMs: 10 });
  coordinator.restore();
  recoverExecution();
  recoverTeamWork();
  assert.deepEqual(teamState(team.id).working, [owner.id]);
  let completions = 0;
  onRunEnd((ended) => { if (ended.runId === runId) completions++; });
  const done = nativeRunPromise(runId);
  assert(done, 'The original native run must regain its application completion handle.');
  coordinator.start();
  assert(isChatBusy(conversation.id));
  assert(activeRuns().some((run) => run.id === runId));
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 30000;
    while (!ok()) { assert(Date.now() < deadline, 'Lifecycle recovery timed out.'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  };
  await until(() => lifecycleWaiting === 1);
  await runtime!.close();
  host = await startRuntime();
  assert(isChatBusy(conversation.id), 'Transport loss must keep the same native run busy.');
  await until(() => lifecycleWaiting === 2);
  releaseLifecycle();
  assert.equal(await done, 'ATHENA_INTEGRATION_REPLY');
  await until(() => !teamState(team.id).working.length);
  assert.deepEqual(teamMessages(team.id).filter((message) => message.from === owner.id).map((message) => message.text), ['ATHENA_INTEGRATION_REPLY']);
  assert.equal(readJSON<{ seen: Record<string, number> }>(threadFile)!.seen[owner.id], 1);
  assert.equal(completions, 1);
  assert(!isChatBusy(conversation.id));
  const transcript = chats.get(owner.id, conversation.id)!;
  assert.equal(transcript.items.filter((item) => item.type === 'tool').length, 1);
  assert.equal(transcript.items.filter((item) => item.type === 'assistant').length, 1);
  assert.equal(requests, 16, 'Only the interrupted model request may repeat; the committed tool must not run again.');
  console.log('eve integration: native busy state, transcript, team result and read marks survive worker restart without another input');
  const admissionOwner = agents.save(newAgent({ engine: 'eve', name: 'Admission owner', provider: 'custom', model: 'integration-proof', toolGroups: [], richAnswers: false, temperature: 0, effort: 'high' }));
  const admissionChat = chats.create(admissionOwner.id, 'Saved admission');
  admissionChat.items = [{ type: 'user', text: 'ORIGINAL_USER_ROLE' }, { type: 'assistant', text: 'ORIGINAL_ASSISTANT_ROLE' }];
  chats.save(admissionChat);
  const uploadDir = newBatch().dir;
  const image = path.join(uploadDir, 'original.png');
  const document = path.join(uploadDir, 'original.pdf');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(document, '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  for (const [index, attachments] of [[image, document], []].entries()) {
    const id = `admission-proof-${index}`;
    const text = `ADMISSION_PROOF_${index}`;
    admitExecution({ id, projectId: project.id, agentId: admissionOwner.id, chatId: admissionChat.id, engine: admissionOwner.engine, parentRunId: null, ownerAgentId: admissionOwner.id, ownerChatId: admissionChat.id, depth: 0, text, from: null, attachments, startedAt: Date.now(), status: 'running' });
    const latest = chats.get(admissionOwner.id, admissionChat.id)!;
    latest.items.push({ type: 'user', text, runId: id, attachments });
    chats.save(latest);
    const input = await prepareAdmission(id, project);
    if (!index) { fs.unlinkSync(image); fs.unlinkSync(document); }
    class LostReceiptClient extends Client {
      override async fetch(route: string, init?: RequestInit): Promise<Response> {
        const response = await super.fetch(route, init);
        assert(response.ok, `Native admission failed: ${response.status} ${await response.clone().text()}`);
        throw new Error('INJECTED_LOST_RECEIPT');
      }
    }
    const dropped = new LostReceiptClient({ baseUrl: host.url, auth: { bearer: host.token }, headers: { 'x-athena-binding': input.bindingId } });
    await assert.rejects(submitAdmission(input, dropped), /INJECTED_LOST_RECEIPT/);
    assert.equal(readAdmission(id)?.status, 'prepared');
    await runtime!.close();
    host = await startRuntime();
    assert.equal(readAdmission(id)?.status, 'accepted');
    await coordinator.follow(id);
    assert.equal(readRun(id)?.status, 'completed');
    assert.equal(readRun(id)?.answer, 'ADMISSION_REPLY');
    assert.deepEqual(eveUsage(id), { cost: 0.01, tokens: 110, cached: 40, context: 110 });
    assert.equal(readRun(id)?.costBaseline, index * 0.01);
    updateExecution(id, { status: 'completed', answer: 'ADMISSION_REPLY', settled: true });
    if (!index) assert.equal(input.mode, 'create');
    else { assert.equal(input.mode, 'send'); assert.equal(readBinding(input.bindingId)?.sessionId, input.sessionId); }
  }
  assert.equal(admittedMessages.length, 2, 'Lost create/send receipts must not duplicate native deliveries.');
  const originals = JSON.stringify(admittedMessages[0]);
  assert(originals.includes('ORIGINAL_USER_ROLE') && originals.includes('ORIGINAL_ASSISTANT_ROLE'));
  assert(originals.includes('image_url') && originals.includes('data:image/png;base64,'));
  assert(originals.includes('file_data') && originals.includes('data:application/pdf;base64,'));
  assert(Array.isArray(admittedMessages[0]) && admittedMessages[0].some((item: unknown) => !!item && typeof item === 'object' && 'role' in item && item.role === 'assistant' && JSON.stringify(item).includes('ORIGINAL_ASSISTANT_ROLE')));
  assert.equal(requests, 18);
  console.log('eve integration: lost create/send receipts recover one delivery, with original roles and saved image/PDF bytes');
  for (const limit of ['steps', 'cost'] as const) {
    saveSettings({ maxToolSteps: limit === 'steps' ? 1 : 16, costLimitUsdPerRun: limit === 'cost' ? 0.005 : 2 });
    const workspace = path.join(temporary, `limit-${limit}`);
    fs.mkdirSync(workspace);
    const limited = agents.save(newAgent({ engine: 'eve', name: `Limited ${limit}`, provider: 'custom', model: 'integration-proof', toolGroups: limit === 'cost' ? ['files'] : ['agents'], autonomy: 'ask', workspace, richAnswers: false }));
    const chat = chats.create(limited.id, 'Native limits');
    const id = `limit-${limit}`;
    const text = limit === 'cost' ? 'DURABLE_WRITE_PROOF' : 'LIMIT_PROOF';
    admitExecution({ id, projectId: project.id, agentId: limited.id, chatId: chat.id, engine: limited.engine, parentRunId: null, ownerAgentId: limited.id, ownerChatId: chat.id, depth: 0, text, from: null, attachments: [], startedAt: Date.now(), status: 'running' });
    chat.items.push({ type: 'user', text, runId: id });
    chats.save(chat);
    const input = await prepareAdmission(id, project);
    await submitAdmission(input, eveClient(host, input.bindingId));
    const followed = coordinator.follow(id);
    if (limit === 'cost') {
      const sessionId = readBinding(input.bindingId)!.sessionId!;
      const session = eveClient(host, input.bindingId).sessions.attach(sessionId);
      let settledLine: number | undefined;
      for await (const event of session.stream({ signal: AbortSignal.timeout(30000) })) {
        if (event.type === 'delivery.settled' && event.data.deliveryId === readRun(id)?.deliveryId) settledLine = event.meta.position.line;
        if (settledLine !== undefined && event.meta.endOfLine !== false && event.meta.position.line >= settledLine) break;
      }
      reconcileSnapshot(id, await session.snapshot());
      assert.equal(readRun(id)?.status, 'waiting');
      await runtime!.close();
      host = await startRuntime();
      const approval = listApprovals().find((item) => item.data.runId === id);
      assert(approval);
      decide(approval.id, { approved: true });
    }
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([followed, new Promise<never>((_, reject) => { limitTimer = setTimeout(() => reject(new Error(`Native ${limit} limit timed out: ${JSON.stringify(readRun(id))}`)), 30000); })]);
    } finally { clearTimeout(limitTimer); }
    assert.equal(readRun(id)?.status, 'failed');
    assert(readRun(id)?.limitReason?.includes(limit === 'steps' ? '1 model steps' : '$0.005 limit'), JSON.stringify(readRun(id)));
    assert.equal(eveUsage(id).cost, 0.01);
    if (limit === 'cost') assert.equal(fs.readFileSync(path.join(workspace, 'approved.txt'), 'utf8'), 'saved once');
  }
  assert.equal(requests, 20, 'Each native limit must stop before a second model call.');
  console.log('eve integration: temperature, effort, cost/cache totals and step/cost limits reach the native runtime');
} finally {
  releaseLifecycle();
  onRunEnd(null);
  await coordinator?.close();
  await runtime?.close();
  await bridge.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  assert(temporary.startsWith(path.join(os.tmpdir(), 'athena-eve-integration-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}
