// API-model engine: OpenRouter, LM Studio, Ollama or any OpenAI-compatible server, with tool calling.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, getSecrets } from '../store.ts';
import { attachedImages } from '../uploads.ts';
import { callTool as callBuiltin, toolDefs, gate } from '../tools.ts';
import * as mcp from '../mcp.ts';
import { PORT } from '../util.ts';
import type { FetchError } from '../util.ts';
import type { Agent, EngineStatus, ProviderId, RunEvent } from '../../shared/types.ts';
import type { EngineRunArgs, EngineResult } from './index.ts';

export interface ProviderDef {
  label: string;
  base: () => string;
  key: () => string | undefined;
  needsKey?: boolean;
}

/** A provider ready to call: base URL without the trailing slash, and the request headers. */
interface Provider {
  id: string;
  base: string;
  headers: Record<string, string>;
}

/** A model as GET /api/models lists it. price is USD per million tokens. */
export interface ModelInfo {
  id: string;
  name: string;
  context: number | null;
  tools: boolean;
  price: { in: number; out: number } | null;
}

/** A row of an OpenAI-compatible /models answer (OpenRouter adds the extra fields). */
interface ApiModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt: string; completion: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Part of a user message: text, or an attached image. Images are kept as `dash-file:<path>` and read when sent. */
export type UserPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** The OpenAI-style messages kept in chat.llm. */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

type ToolRoute = { kind: 'builtin'; name: string } | { kind: 'mcp'; server: string; name: string };

interface Usage {
  cost?: number;
  total_tokens?: number;
}

/** One `data:` line of a streamed chat completion. */
interface StreamChunk {
  error?: { message?: string };
  usage?: Usage;
  choices?: {
    finish_reason?: string | null;
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
  }[];
}

interface Completion {
  content: string;
  calls: ToolCall[];
  usage: Usage | null;
  finish: string | null;
}

/** What a tool call hands back to the model (built-in or MCP). */
interface ToolOutput {
  text: string;
  images?: string[];
  isError?: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  openrouter: { label: 'OpenRouter', base: () => 'https://openrouter.ai/api/v1', key: () => getSecrets().openrouterKey, needsKey: true },
  lmstudio: { label: 'LM Studio (local)', base: () => getSettings().providers.lmstudio.baseUrl, key: () => 'lm-studio' },
  ollama: { label: 'Ollama (local)', base: () => getSettings().providers.ollama.baseUrl, key: () => 'ollama' },
  custom: { label: 'Custom', base: () => getSettings().providers.custom.baseUrl, key: () => getSecrets().customKey || 'none' },
};

export function status(): EngineStatus['openai'] {
  return { openrouter: !!getSecrets().openrouterKey, custom: !!getSettings().providers.custom.baseUrl };
}

function providerOf(agent: Agent): Provider {
  const id = agent.provider || 'openrouter';
  const p: ProviderDef | undefined = (PROVIDERS as Partial<Record<string, ProviderDef>>)[id];
  if (!p) throw new Error(`Unknown provider ${id}`);
  const base = (p.base() || '').replace(/\/$/, '');
  const key = p.key();
  if (!base) throw new Error(`${p.label} has no address. Set it in Settings.`);
  if (p.needsKey && !key) throw new Error('Add your OpenRouter key in Settings first.');
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (id === 'openrouter') Object.assign(headers, { 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'My Dashboard' });
  return { id, base, headers };
}

export async function listModels(providerId: string): Promise<ModelInfo[]> {
  const p: ProviderDef | undefined = (PROVIDERS as Partial<Record<string, ProviderDef>>)[providerId];
  if (!p) return [];
  const base = (p.base() || '').replace(/\/$/, '');
  if (!base) return [];
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${p.key() || ''}` }, signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { data?: ApiModel[] };
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

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

async function gatherTools(agent: Agent, onEvent: (ev: RunEvent) => void): Promise<{ defs: ToolDef[]; route: Map<string, ToolRoute> }> {
  const defs: ToolDef[] = toolDefs(agent).map((t): ToolDef => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const route = new Map<string, ToolRoute>(defs.map((d): [string, ToolRoute] => [d.function.name, { kind: 'builtin', name: d.function.name }]));
  for (const server of agent.mcpServers || []) {
    try {
      const tools = await mcp.listTools(server);
      for (const t of tools) {
        const name = safeName(`${server}__${t.name}`);
        route.set(name, { kind: 'mcp', server, name: t.name });
        defs.push({ type: 'function', function: { name, description: `[${server}] ${t.description || ''}`.slice(0, 1000), parameters: t.inputSchema || { type: 'object', properties: {} } } });
      }
    } catch (e) {
      onEvent({ kind: 'status', text: `MCP server ${server} unavailable: ${(e as Error).message}` });
    }
  }
  return { defs, route };
}

async function streamCompletion({ provider, body, signal, onEvent }: { provider: Provider; body: Record<string, unknown>; signal: AbortSignal; onEvent: (ev: RunEvent) => void }): Promise<Completion> {
  const res = await fetch(`${provider.base}/chat/completions`, { method: 'POST', headers: provider.headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const t = await res.text();
    let msg = t;
    try {
      msg = (JSON.parse(t) as StreamChunk).error?.message || t;
    } catch {
      /* not json */
    }
    const e: FetchError = new Error(`${res.status}: ${String(msg).slice(0, 600)}`);
    e.status = res.status;
    throw e;
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const calls: ToolCall[] = [];
  let usage: Usage | null = null;
  let finish: string | null = null;
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
      let j: StreamChunk;
      try {
        j = JSON.parse(data) as StreamChunk;
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

const FILE_URL = 'dash-file:';
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// The attached images a vision model gets to see (a few, not too big).
function imageParts(attachments: string[]): UserPart[] {
  return attachedImages(attachments)
    .filter((p) => {
      try {
        return fs.statSync(p).size <= IMAGE_MAX_BYTES;
      } catch {
        return false;
      }
    })
    .slice(0, 6)
    .map((p) => ({ type: 'image_url', image_url: { url: FILE_URL + p } }));
}

// What is sent: image files read as data URLs, or (vision off) a note in their place.
export function expandImages(msgs: LlmMessage[], vision: boolean): LlmMessage[] {
  return msgs.map((m) => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    const parts = m.content.map((part): UserPart => {
      if (part.type !== 'image_url' || !part.image_url.url.startsWith(FILE_URL)) return part;
      const file = part.image_url.url.slice(FILE_URL.length);
      if (!vision) return { type: 'text', text: `(image ${path.basename(file)} attached; this model can't see images)` };
      try {
        return { type: 'image_url', image_url: { url: `data:${MIME[path.extname(file).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}` } };
      } catch {
        return { type: 'text', text: `(image ${path.basename(file)} is no longer there)` };
      }
    });
    return { ...m, content: vision ? parts : parts.map((x) => (x.type === 'text' ? x.text : '')).join('\n\n') };
  });
}

const hasImages = (msgs: LlmMessage[]) => msgs.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'image_url'));

export async function run({ agent, chat, text, signal, onEvent, depth, runId, systemPrompt, attachments = [] }: EngineRunArgs): Promise<EngineResult> {
  const provider = providerOf(agent);
  const settings = getSettings();
  const model = agent.model || settings.defaults.openrouterModel;
  chat.llm ||= [];
  const images = imageParts(attachments);
  chat.llm.push({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text });
  // off once the model says it can't take images
  let vision = true;
  onEvent({ kind: 'model', model });
  let { defs, route } = await gatherTools(agent, onEvent);
  let cost = 0;
  let tokens = 0;
  let finalText = '';
  const maxSteps = settings.maxToolSteps || 16;

  for (let step = 0; step < maxSteps; step++) {
    const body = {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...expandImages(trimHistory(chat.llm as LlmMessage[]), vision)],
      stream: true,
      ...(defs.length ? { tools: defs } : {}),
      ...(provider.id === 'openrouter' ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
      ...(agent.temperature != null && agent.temperature !== '' ? { temperature: Number(agent.temperature) } : {}),
    };
    let r: Completion;
    try {
      r = await streamCompletion({ provider, body, signal, onEvent });
    } catch (e) {
      // A model without vision: send the images as notes instead.
      const err = e as FetchError;
      if (vision && hasImages(trimHistory(chat.llm as LlmMessage[])) && [400, 404, 415, 422].includes(err.status ?? 0) && /image|vision|multimodal|modalit/i.test(err.message)) {
        onEvent({ kind: 'status', text: `${model} can't see images; sending it the file paths instead.` });
        vision = false;
        step--;
        continue;
      }
      // Some models can't call tools: try once more without them.
      if (defs.length && /tool|function/i.test((e as FetchError).message) && ((e as FetchError).status === 404 || (e as FetchError).status === 400)) {
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
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        onEvent({ kind: 'tool', id: call.id, name: call.function.name, args });
        const target = route.get(call.function.name);
        const ctx = { runId, depth, signal, progress: (t: string) => onEvent({ kind: 'status', text: t }) };
        let job: Promise<ToolOutput>;
        if (!target) job = Promise.resolve({ text: `No tool called ${call.function.name}.`, isError: true });
        else if (target.kind === 'builtin') job = callBuiltin(agent, target.name, args, ctx);
        else
          job = (async () => {
            const refused = await gate(agent, call.function.name, 'low', args, ctx);
            if (refused) return refused;
            return mcp.callTool(target.server, target.name, args);
          })().catch((e: Error) => ({ text: `Error: ${e.message}`, isError: true }));
        // Stop must not wait for a slow tool to finish.
        // (the stop listener is removed again when the tool finishes first, so long runs don't pile them up)
        let onStop: (() => void) | null = null;
        const stopped = new Promise<never>((_, rej) => {
          onStop = () => rej(new Error('Stopped.'));
          if (signal.aborted) onStop();
          else signal.addEventListener('abort', onStop, { once: true });
        });
        const result = await Promise.race([job, stopped]).finally(() => onStop && signal.removeEventListener('abort', onStop));
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
function trimHistory(msgs: LlmMessage[], maxChars = 400_000): LlmMessage[] {
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
