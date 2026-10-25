// API-model engine: OpenRouter, LM Studio, Ollama or any OpenAI-compatible server, with tool calling.
import { getSettings, getSecrets } from '../store.js';
import { callTool as callBuiltin, toolDefs, gate } from '../tools.js';
import * as mcp from '../mcp.js';
import { PORT } from '../util.js';

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', base: () => 'https://openrouter.ai/api/v1', key: () => getSecrets().openrouterKey, needsKey: true },
  lmstudio: { label: 'LM Studio (local)', base: () => getSettings().providers.lmstudio.baseUrl, key: () => 'lm-studio' },
  ollama: { label: 'Ollama (local)', base: () => getSettings().providers.ollama.baseUrl, key: () => 'ollama' },
  custom: { label: 'Custom', base: () => getSettings().providers.custom.baseUrl, key: () => getSecrets().customKey || 'none' },
};

export function status() {
  return { openrouter: !!getSecrets().openrouterKey, custom: !!getSettings().providers.custom.baseUrl };
}

function providerOf(agent) {
  const id = agent.provider || 'openrouter';
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider ${id}`);
  const base = (p.base() || '').replace(/\/$/, '');
  const key = p.key();
  if (!base) throw new Error(`${p.label} has no address. Set it in Settings.`);
  if (p.needsKey && !key) throw new Error('Add your OpenRouter key in Settings first.');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (id === 'openrouter') Object.assign(headers, { 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'My Dashboard' });
  return { id, base, headers };
}

export async function listModels(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return [];
  const base = (p.base() || '').replace(/\/$/, '');
  if (!base) return [];
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${p.key() || ''}` }, signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return (j.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || null,
      tools: providerId === 'openrouter' ? (m.supported_parameters || []).includes('tools') : true,
      price: m.pricing ? { in: +m.pricing.prompt * 1e6, out: +m.pricing.completion * 1e6 } : null,
    }));
  } catch {
    return [];
  }
}

const safeName = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

async function gatherTools(agent, onEvent) {
  const defs = toolDefs(agent).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const route = new Map(defs.map((d) => [d.function.name, { kind: 'builtin', name: d.function.name }]));
  for (const server of agent.mcpServers || []) {
    try {
      const tools = await mcp.listTools(server);
      for (const t of tools) {
        const name = safeName(`${server}__${t.name}`);
        route.set(name, { kind: 'mcp', server, name: t.name });
        defs.push({ type: 'function', function: { name, description: `[${server}] ${t.description || ''}`.slice(0, 1000), parameters: t.inputSchema || { type: 'object', properties: {} } } });
      }
    } catch (e) {
      onEvent({ kind: 'status', text: `MCP server ${server} unavailable: ${e.message}` });
    }
  }
  return { defs, route };
}

async function streamCompletion({ provider, body, signal, onEvent }) {
  const res = await fetch(`${provider.base}/chat/completions`, { method: 'POST', headers: provider.headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const t = await res.text();
    let msg = t;
    try {
      msg = JSON.parse(t).error?.message || t;
    } catch {
      /* not json */
    }
    const e = new Error(`${res.status}: ${String(msg).slice(0, 600)}`);
    e.status = res.status;
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];
  let usage = null;
  let finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        content += d.content;
        onEvent({ kind: 'text', text: d.content });
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, calls: calls.filter(Boolean), usage, finish };
}

export async function run({ agent, chat, text, signal, onEvent, depth, runId, systemPrompt }) {
  const provider = providerOf(agent);
  const settings = getSettings();
  const model = agent.model || settings.defaults.openrouterModel;
  chat.llm ||= [];
  chat.llm.push({ role: 'user', content: text });
  onEvent({ kind: 'model', model });
  let { defs, route } = await gatherTools(agent, onEvent);
  let cost = 0;
  let tokens = 0;
  let finalText = '';
  const maxSteps = settings.maxToolSteps || 16;

  for (let step = 0; step < maxSteps; step++) {
    const body = {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...trimHistory(chat.llm)],
      stream: true,
      ...(defs.length ? { tools: defs } : {}),
      ...(provider.id === 'openrouter' ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
      ...(agent.temperature != null && agent.temperature !== '' ? { temperature: Number(agent.temperature) } : {}),
    };
    let r;
    try {
      r = await streamCompletion({ provider, body, signal, onEvent });
    } catch (e) {
      // Some models can't call tools: try once more without them.
      if (defs.length && /tool|function/i.test(e.message) && (e.status === 404 || e.status === 400)) {
        onEvent({ kind: 'status', text: `${model} can't use tools; answering without them.` });
        defs = [];
        step--;
        continue;
      }
      throw e;
    }
    if (r.usage) {
      cost += Number(r.usage.cost || 0);
      tokens += Number(r.usage.total_tokens || 0);
    }
    // Some providers leave ids empty; results must match their call.
    for (const c of r.calls) c.id ||= `call_${Math.random().toString(36).slice(2, 12)}`;
    chat.llm.push({ role: 'assistant', content: r.content || null, ...(r.calls.length ? { tool_calls: r.calls } : {}) });
    if (r.content) finalText = r.content;
    if (!r.calls.length) break;

    const answered = new Set();
    try {
      for (const call of r.calls) {
        if (signal.aborted) throw new Error('Stopped.');
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        onEvent({ kind: 'tool', id: call.id, name: call.function.name, args });
        const target = route.get(call.function.name);
        const ctx = { runId, depth, signal, progress: (t) => onEvent({ kind: 'status', text: t }) };
        let job;
        if (!target) job = Promise.resolve({ text: `No tool called ${call.function.name}.`, isError: true });
        else if (target.kind === 'builtin') job = callBuiltin(agent, target.name, args, ctx);
        else
          job = (async () => {
            const refused = await gate(agent, call.function.name, 'low', args, ctx);
            if (refused) return refused;
            return mcp.callTool(target.server, target.name, args);
          })().catch((e) => ({ text: `Error: ${e.message}`, isError: true }));
        // Stop must not wait for a slow tool to finish.
        const result = await Promise.race([job, new Promise((_, rej) => (signal.aborted ? rej(new Error('Stopped.')) : signal.addEventListener('abort', () => rej(new Error('Stopped.')), { once: true })))]);
        onEvent({ kind: 'tool_result', id: call.id, text: result.text, images: result.images, isError: result.isError });
        const note = result.images?.length ? `\n[${result.images.length} image(s) shown to the user]` : '';
        chat.llm.push({ role: 'tool', tool_call_id: call.id, content: String(result.text || '(no output)').slice(0, 24000) + note });
        answered.add(call.id);
      }
    } finally {
      // Every tool call needs a result, or the provider rejects the next message.
      for (const call of r.calls) if (!answered.has(call.id)) chat.llm.push({ role: 'tool', tool_call_id: call.id, content: '(not run: the user stopped this)' });
    }
    if (settings.costLimitUsdPerRun && cost > settings.costLimitUsdPerRun) {
      onEvent({ kind: 'text', text: `\n\n_Stopped: this run passed the $${settings.costLimitUsdPerRun} limit set in Settings._` });
      break;
    }
    if (step === maxSteps - 1) onEvent({ kind: 'text', text: `\n\n_Stopped after ${maxSteps} tool steps (Settings > Max tool steps)._` });
  }
  return { text: finalText, cost, tokens };
}

// Keep the conversation under a rough size budget, cutting oldest turns at a user message boundary.
function trimHistory(msgs, maxChars = 400_000) {
  let total = 0;
  let start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += JSON.stringify(msgs[i]).length;
    if (total > maxChars) break;
    start = i;
  }
  while (start < msgs.length && msgs[start].role !== 'user') start++;
  return msgs.slice(start);
}
