// Checks what scripts/build-desktop.ts staged, the way the desktop app runs it: the bundled Bun
// starts the bundled server on a free port with a throwaway data folder and home folder, the page and an API answer,
// the bundled tools work (a PDF is read too), the MCP bridge starts, and the server stops by itself once its stdin closes.
// Run after build-desktop: bun scripts/desktop-smoke.ts [--target <triple>]
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { desktopTarget, hostTriple } from './desktop-target.ts';
import type { Agent, AppState, Chat, ConversationReadResult, ConversationSearchResult, TaskBatchResult } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const app = path.join(root, 'src-tauri', 'app');
const host = hostTriple(Bun.spawnSync(['rustc', '-vV']).stdout.toString());
const i = process.argv.indexOf('--target');
const t = desktopTarget(i > 0 ? process.argv[i + 1] : host);
const bun = path.join(root, 'src-tauri', 'binaries', `bun-${t.triple}${t.exe}`);
for (const f of [bun, path.join(app, 'server', 'index.js'), path.join(app, 'server', 'mcp-bridge.js')]) {
  if (!fs.existsSync(f)) throw new Error(`Missing ${f}. Run: bun scripts/build-desktop.ts`);
}

const eve = Bun.spawn([bun, path.join(root, 'scripts/eve-smoke.ts'), path.join(app, 'runtime/eve/server/index.mjs'), bun, path.join(app, 'runtime/eve-sandbox-cache')], {
  stdout: 'inherit', stderr: 'inherit',
});
if (await eve.exited !== 0) throw new Error('The staged Eve runtime failed its smoke check.');
const recovery = Bun.spawn([bun, path.join(root, 'scripts/eve-recovery-smoke.ts'), path.join(app, 'runtime/eve/server/index.mjs'), bun, path.join(app, 'runtime/eve-sandbox-cache')], { stdout: 'inherit', stderr: 'inherit' });
if (await recovery.exited !== 0) throw new Error('The staged Eve runtime failed its recovery check.');

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });

/** A one-page PDF saying text, with a correct cross-reference table. */
function onePagePdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

function fail(msg: string): never {
  console.error(`smoke: FAILED: ${msg}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-smoke-'));
const data = path.join(tmp, 'data');
// a home of its own too: the default project's folder is <home>/Documents/Athena Agents, and its auto-save
// must never touch yours
const home = path.join(tmp, 'home');
fs.mkdirSync(data);
fs.mkdirSync(home);
const isolated = { DASH_DATA: data, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') };
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// cwd outside the repo, so nothing can be found by accident next to the sources
const server = Bun.spawn([bun, path.join(app, 'server', 'index.js'), '--port', String(port), '--no-open'], {
  cwd: data,
  env: { ...process.env, ...isolated, DASH_DESKTOP: '1' },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});
let output = '';
for (const stream of [server.stdout, server.stderr]) {
  void (async () => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  })();
}

try {
  const until = Date.now() + 60_000;
  let page = '';
  while (Date.now() < until) {
    if (server.exitCode !== null) fail(`the server exited (${server.exitCode}):\n${output}`);
    try {
      const res = await fetch(base + '/');
      if (res.ok) {
        page = await res.text();
        break;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  if (!page) fail(`the server did not answer within 60 s:\n${output}`);
  if (!page.includes('dist/app.js')) fail('the page does not load the app bundle');
  console.log('smoke: page ok');

  for (const p of ['/dist/app.js', '/dist/app.css', '/vendor/xterm.css']) {
    const r = await fetch(base + p);
    if (!r.ok) fail(`${p} answered ${r.status}`);
  }
  const settings = await fetch(base + '/api/settings');
  if (!settings.ok) fail(`/api/settings answered ${settings.status}`);
  console.log('smoke: static files and API ok');

  // Exercise the bundled history module through the same internal endpoint the MCP bridge uses.
  const state = await (await fetch(base + '/api/state')).json() as AppState;
  if (path.resolve(state.dataDir) !== path.resolve(data)) fail('the responding server is not using our throwaway data');
  const headers = { 'content-type': 'application/json', 'x-dash': '1' };
  const agent = await (await fetch(base + '/api/agents', { method: 'POST', headers, body: JSON.stringify({ name: 'Smoke searcher', toolGroups: [] }) })).json() as Agent;
  const chat = await (await fetch(base + `/api/agents/${agent.id}/chats`, { method: 'POST', headers, body: '{}' })).json() as Chat;
  chat.items.push({ type: 'user', text: 'SAVED_CONVERSATION_SMOKE_ORIGINAL' });
  // The fixture lives only in the verified throwaway project; no model or real agent is started.
  fs.writeFileSync(path.join(data, 'projects', state.project.id, 'chats', agent.id, `${chat.id}.json`), JSON.stringify(chat));
  const token = fs.readFileSync(path.join(data, '.internal-token'), 'utf8').trim();
  const historyTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const response = await fetch(base + '/api/internal/tools/call', { method: 'POST', headers: { ...headers, 'x-dash-internal': token }, body: JSON.stringify({ agent: agent.id, name, args }) });
    const result = await response.json() as { text: string; isError?: boolean };
    if (!response.ok || result.isError) fail(`dashboard tool ${name} failed: ${result.text}`);
    return result.text;
  };
  const found = JSON.parse(await historyTool('search_conversations', { query: 'SAVED_CONVERSATION_SMOKE_ORIGINAL', scope: 'own' })) as ConversationSearchResult;
  if (found.hits.length !== 1) fail('the bundled conversation search did not find the saved original');
  const original = JSON.parse(await historyTool('read_conversation', { ...found.hits[0] })) as ConversationReadResult;
  if (original.text !== 'SAVED_CONVERSATION_SMOKE_ORIGINAL') fail('the bundled conversation reader changed the original');
  console.log('smoke: conversation search and read ok');
  const createdTask = JSON.parse(await historyTool('TaskCreate', { subject: 'Bundled task smoke', description: 'Verify saved task tools in the desktop server.' })) as { task: { id: string } };
  const tasks = JSON.parse(await historyTool('TaskList', {})) as { tasks: { id: string }[] };
  if (!tasks.tasks.some((t) => t.id === createdTask.task.id)) fail('the bundled task list did not include the new task');
  await historyTool('TaskUpdate', { taskId: createdTask.task.id, status: 'completed' });
  const savedTask = JSON.parse(await historyTool('TaskGet', { taskId: createdTask.task.id })) as { task: { status: string } };
  if (savedTask.task.status !== 'completed') fail('the bundled task update was not saved');
  console.log('smoke: task create, list, update and read ok');
  const bulk = JSON.parse(await historyTool('TaskCreate', { tasks: [{ subject: 'First bundled batch task', description: 'Keep this item.' }, { subject: '', description: 'Report this failure.' }, { subject: 'Last bundled batch task', description: 'Keep later successes.' }] })) as TaskBatchResult;
  if (bulk.results.length !== 3 || !bulk.results[0].success || bulk.results[1].success || !bulk.results[2].success) fail('the bundled create batch lost a per-item outcome');
  const updates = bulk.results.flatMap((r) => r.success ? [{ taskId: r.taskId, status: 'completed' }] : []);
  const changed = JSON.parse(await historyTool('TaskUpdate', { tasks: updates })) as TaskBatchResult;
  if (changed.results.length !== 2 || !changed.results.every((r) => r.success && r.status === 'completed')) fail('the bundled update batch did not finish every task');
  console.log('smoke: bulk task create and update ok');

  // the PDF reader runs in a thread of its own, from its own file in the bundle: read an attached PDF with it
  const uploads = path.join(state.project.brainPath, 'uploads', 'smoke');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'smoke.pdf'), onePagePdf('BUNDLED_PDF_SMOKE'));
  if (!(await historyTool('read_document', { path: path.join(uploads, 'smoke.pdf') })).includes('BUNDLED_PDF_SMOKE')) fail('the bundled PDF reader did not read the PDF');
  console.log('smoke: PDF reading ok');

  // the bridge, as Claude Code would start it: one MCP initialize request over stdio
  const bridge = Bun.spawn([bun, path.join(app, 'server', 'mcp-bridge.js')], {
    env: { ...process.env, ...isolated, DASH_PORT: String(port) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } };
  bridge.stdin.write(JSON.stringify(init) + '\n');
  await bridge.stdin.flush();
  const reader = bridge.stdout.getReader();
  const timer = setTimeout(() => bridge.kill(), 20_000);
  let reply = '';
  while (!reply.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    reply += new TextDecoder().decode(value);
  }
  clearTimeout(timer);
  bridge.kill();
  if (!reply.includes('"serverInfo"')) fail(`the MCP bridge did not answer: ${reply || '(nothing)'}`);
  console.log('smoke: MCP bridge ok');

  // closing stdin is how the desktop app says "stop"
  await server.stdin.end();
  const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!stopped) fail('the server kept running after its stdin closed');
  console.log('smoke: stops with the app ok');
} finally {
  server.kill();
  await server.exited;
  fs.rmSync(tmp, { recursive: true, force: true });
}
