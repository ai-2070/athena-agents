// Hermes engine: one `hermes chat` run per message (stream-json), resuming the Hermes session.
// Hermes brings its own tools, memory and skills from the chosen profile.
import { which, spawnCommand, killTree, run as runCmd } from '../util.js';
import { workspaceOf } from '../tools.js';

let profilesCache = { at: 0, list: [] };
export async function listProfiles() {
  if (Date.now() - profilesCache.at < 60_000) return profilesCache.list;
  if (!which('hermes')) return [];
  const r = await runCmd('hermes', ['profile', 'list'], { timeout: 60000 });
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*[◆*]?\s*([A-Za-z0-9][\w.-]*)\s+(\S+)\s+(running|stopped|\S+)/.exec(line);
    if (m && m[1] !== 'Profile') list.push({ name: m[1], model: m[2], gateway: m[3], isDefault: /^\s*◆/.test(line) });
  }
  profilesCache = { at: Date.now(), list };
  return list;
}

export function status() {
  return { installed: !!which('hermes'), path: which('hermes') };
}

export function hermesArgs(agent, { interactive = false } = {}) {
  const args = [];
  if (agent.hermesProfile && agent.hermesProfile !== 'default') args.push('-p', agent.hermesProfile);
  args.push('chat');
  if (!interactive) args.push('--query-file', '-', '--format', 'stream-json');
  if (agent.model) args.push('-m', agent.model);
  if (agent.autonomy === 'full') args.push('--yolo');
  return args;
}

export async function run({ agent, chat, text, signal, onEvent, systemPrompt }) {
  if (!which('hermes')) throw new Error('Hermes is not installed (the `hermes` command was not found).');
  const args = hermesArgs(agent);
  if (chat.sessionId) args.push('--resume', chat.sessionId, '--no-restore-cwd');
  // Hermes keeps its own system prompt; our agent brief is sent with the first message.
  const query = chat.sessionId ? text : `${systemPrompt}\n\n---\n\n${text}`;
  const child = spawnCommand('hermes', args, { cwd: workspaceOf(agent), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort);
  let buf = '';
  let stderr = '';
  let result = null;
  let toolN = 0;

  const handle = (msg) => {
    if (msg.session_id) chat.sessionId = msg.session_id;
    if (msg.type === 'system' && msg.model) onEvent({ kind: 'model', model: msg.model });
    if (msg.type === 'text' && msg.text) onEvent({ kind: 'text', text: msg.text });
    else if (msg.type === 'result') result = msg;
    else if (/tool/.test(msg.type || '')) {
      const id = msg.id || msg.tool_call_id || `h${++toolN}`;
      if (/result|output|end/.test(msg.type)) onEvent({ kind: 'tool_result', id: msg.tool_call_id || msg.id || `h${toolN}`, text: String(msg.output ?? msg.result ?? msg.text ?? ''), isError: !!msg.error });
      else onEvent({ kind: 'tool', id, name: msg.name || msg.tool || 'tool', args: msg.args || msg.arguments || msg.input || {} });
    } else if (msg.type === 'status' || msg.type === 'progress') onEvent({ kind: 'status', text: msg.text || msg.message || '' });
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  });
  child.stderr.on('data', (d) => {
    if (stderr.length < 200_000) stderr += d;
  });
  child.stdin.end(query);
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (e) => {
      stderr += e.message;
      resolve(-1);
    });
  });
  const rest = buf.trim();
  if (rest.startsWith('{')) {
    try {
      handle(JSON.parse(rest));
    } catch {
      /* partial line */
    }
  }
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted) throw new Error('Stopped.');
  if (!result) throw new Error(`Hermes exited (${code}) without an answer.${stderr ? `\n${stderr.trim().slice(-1500)}` : ''}`);
  if (result.exit_code && result.exit_code !== 0) throw new Error(result.text || `Hermes failed (exit ${result.exit_code}).`);
  return { text: result.text || '', tokens: result.tokens?.total || 0 };
}
