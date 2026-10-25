// ComfyUI: find the running server, list saved workflows, run them with your changes, collect images.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getProgram, comfyWorkflowDirs, launchProgram } from './programs.js';
import { fetchJSON, readJSON, listFiles, dataPath, ensureDir } from './util.js';

const API_DIR = ensureDir(dataPath('comfy-workflows'));

export async function comfyUrl() {
  const p = await getProgram('comfyui');
  return p?.serviceUrl || null;
}

async function requireUrl() {
  const url = await comfyUrl();
  if (!url) throw new Error('ComfyUI is not running. Start it from Programs (or call launch_program "comfyui"), wait for it to load, then try again.');
  return url;
}

export function listWorkflows() {
  const out = [];
  for (const dir of [API_DIR, ...comfyWorkflowDirs()]) {
    for (const f of listFiles(dir, (n) => n.endsWith('.json'))) {
      out.push({ name: f.replace(/\.json$/, ''), file: path.join(dir, f), dir });
    }
  }
  return out;
}

function findWorkflow(name) {
  const all = listWorkflows();
  const n = String(name || '').replace(/\.json$/, '').toLowerCase();
  return all.find((w) => w.name.toLowerCase() === n) || all.find((w) => w.name.toLowerCase().includes(n)) || null;
}

const isApiFormat = (wf) => wf && !Array.isArray(wf.nodes) && Object.values(wf).every((n) => n && typeof n === 'object' && 'class_type' in n);

let objectInfoCache = { url: null, at: 0, data: null };
async function objectInfo(url) {
  if (objectInfoCache.url === url && Date.now() - objectInfoCache.at < 10 * 60_000) return objectInfoCache.data;
  const data = await fetchJSON(`${url}/object_info`, { timeout: 30000 });
  objectInfoCache = { url, at: Date.now(), data };
  return data;
}

// Turn a workflow saved from the ComfyUI editor into the API format /prompt expects.
function uiToApi(wf, info) {
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const links = new Map((wf.links || []).map((l) => (Array.isArray(l) ? [l[0], { from: l[1], slot: l[2] }] : [l.id, { from: l.origin_id, slot: l.origin_slot }])));
  const warnings = [];

  // Follow a link back through Reroute nodes to the real producer.
  const resolve = (linkId, guard = 0) => {
    const l = links.get(linkId);
    if (!l || guard > 50) return null;
    const src = nodes.get(l.from);
    if (!src) return null;
    if (src.type === 'Reroute' || src.mode === 4) {
      const inLink = src.inputs?.find((i) => i.link != null)?.link;
      return inLink != null ? resolve(inLink, guard + 1) : null;
    }
    if (src.type === 'PrimitiveNode') return { value: src.widgets_values?.[0] };
    return { ref: [String(src.id), l.slot] };
  };

  const api = {};
  for (const node of wf.nodes) {
    if (node.mode === 2 || node.mode === 4) continue; // muted or bypassed
    if (['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'].includes(node.type)) continue;
    const def = info[node.type];
    if (!def) {
      warnings.push(`Node ${node.id} (${node.type}) is not known to this ComfyUI${/^[0-9a-f-]{36}$/.test(node.type) ? ' (it is a subgraph; export the workflow with "Export (API)" instead)' : ''}.`);
      continue;
    }
    const inputs = {};
    const order = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
    const linked = new Map();
    for (const inp of node.inputs || []) if (inp.link != null) linked.set(inp.name, inp.link);
    const wv = node.widgets_values;
    let wi = 0;
    for (const [name, spec] of order) {
      const type = spec?.[0];
      const opts = spec?.[1] || {};
      const isWidget = Array.isArray(type) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(type) || opts.forceInput === false;
      if (linked.has(name)) {
        const r = resolve(linked.get(name));
        if (r?.ref) inputs[name] = r.ref;
        else if (r && 'value' in r) inputs[name] = r.value;
        if (isWidget && !opts.forceInput) {
          wi++;
          if (opts.control_after_generate || /^(noise_)?seed$/.test(name)) wi++;
        }
        continue;
      }
      if (!isWidget || opts.forceInput) continue;
      if (wv && !Array.isArray(wv) && typeof wv === 'object') {
        if (name in wv) inputs[name] = wv[name];
        continue;
      }
      if (Array.isArray(wv) && wi < wv.length) inputs[name] = wv[wi];
      wi++;
      if (opts.control_after_generate || ((type === 'INT') && /^(noise_)?seed$/.test(name))) wi++;
    }
    api[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title || def.display_name || node.type } };
  }
  return { api, warnings };
}

async function loadApiWorkflow(name, url) {
  const w = findWorkflow(name);
  if (!w) throw new Error(`No ComfyUI workflow called "${name}". Available: ${listWorkflows().map((x) => x.name).join(', ') || 'none'}.`);
  const raw = readJSON(w.file);
  if (!raw) throw new Error(`Couldn't read ${w.file}.`);
  if (isApiFormat(raw)) return { api: raw, warnings: [], workflow: w };
  if (!Array.isArray(raw.nodes)) throw new Error(`${w.name} is not a ComfyUI workflow file.`);
  const { api, warnings } = uiToApi(raw, await objectInfo(url));
  return { api, warnings, workflow: w };
}

// What can be changed in a workflow: every node's plain inputs, keyed "nodeId.input".
export async function describeWorkflow(name) {
  const url = await requireUrl();
  const { api, warnings, workflow } = await loadApiWorkflow(name, url);
  const editable = {};
  for (const [id, n] of Object.entries(api)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!Array.isArray(v)) editable[`${id}.${k}`] = { node: n._meta?.title || n.class_type, value: typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v };
    }
  }
  return { workflow: workflow.name, file: workflow.file, prompts: findPromptNodes(api), editable, warnings };
}

// Which text nodes feed a sampler's positive and negative inputs.
function findPromptNodes(api) {
  const res = { positive: null, negative: null };
  for (const n of Object.values(api)) {
    for (const key of ['positive', 'negative']) {
      const ref = n.inputs?.[key];
      if (Array.isArray(ref) && !res[key]) {
        let target = api[ref[0]];
        let id = ref[0];
        // walk through conditioning helpers to the text encoder
        for (let i = 0; i < 6 && target && !('text' in (target.inputs || {})); i++) {
          const next = Object.values(target.inputs || {}).find((v) => Array.isArray(v));
          if (!next) break;
          id = next[0];
          target = api[id];
        }
        if (target && 'text' in target.inputs) res[key] = id;
      }
    }
  }
  return res;
}

export async function runWorkflow({ workflow, prompt, negative, inputs = {}, randomizeSeed = true, wait = true, timeoutSec = 600, onProgress, signal } = {}) {
  const url = await requireUrl();
  const { api, warnings, workflow: w } = await loadApiWorkflow(workflow, url);
  const p = findPromptNodes(api);
  if (prompt != null) {
    if (!p.positive) throw new Error('Could not find the positive prompt node; set it with inputs {"<nodeId>.text": "..."} (see comfyui_describe_workflow).');
    api[p.positive].inputs.text = prompt;
  }
  if (negative != null && p.negative) api[p.negative].inputs.text = negative;
  for (const [key, value] of Object.entries(inputs || {})) {
    const [id, ...rest] = key.split('.');
    const field = rest.join('.');
    if (!api[id]) throw new Error(`Workflow has no node ${id}.`);
    api[id].inputs[field] = value;
  }
  if (randomizeSeed) {
    for (const [id, n] of Object.entries(api)) {
      for (const k of ['seed', 'noise_seed']) if (typeof n.inputs[k] === 'number' && !(`${id}.${k}` in inputs)) n.inputs[k] = Math.floor(Math.random() * 2 ** 48);
    }
  }
  for (const n of Object.values(api)) delete n._meta;
  const clientId = crypto.randomUUID();
  const res = await fetchJSON(`${url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: api, client_id: clientId }),
    timeout: 30000,
  }).catch((e) => {
    const err = e.body?.node_errors ? `${e.message}\n${JSON.stringify(e.body.node_errors).slice(0, 1500)}` : e.message;
    throw new Error(`ComfyUI rejected the workflow: ${err}`);
  });
  const promptId = res.prompt_id;
  if (!wait) return { promptId, queued: true, warnings };
  const started = Date.now();
  while (Date.now() - started < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) {
      // Take the job off ComfyUI's queue too.
      await fetch(`${url}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
      await fetch(`${url}/interrupt`, { method: 'POST' }).catch(() => {});
      throw new Error('Stopped.');
    }
    const hist = await fetchJSON(`${url}/history/${promptId}`, { timeout: 15000 }).catch(() => null);
    const entry = hist?.[promptId];
    if (entry?.status?.status_str === 'error') {
      const msg = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1];
      throw new Error(`ComfyUI failed: ${msg?.exception_message || 'see the ComfyUI console'}`);
    }
    if (entry?.outputs && (entry.status?.completed || Object.keys(entry.outputs).length)) {
      const files = [];
      for (const out of Object.values(entry.outputs)) {
        for (const kind of ['images', 'gifs', 'videos', 'audio']) {
          for (const f of out[kind] || []) {
            const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
            files.push({ ...f, kind, url: `/api/comfyui/view?${q}` });
          }
        }
      }
      return { promptId, workflow: w.name, files, seconds: Math.round((Date.now() - started) / 1000), warnings };
    }
    onProgress?.(Math.round((Date.now() - started) / 1000));
  }
  throw new Error(`Still running after ${timeoutSec}s (prompt ${promptId}). Check ComfyUI.`);
}

export async function queueStatus() {
  const url = await comfyUrl();
  if (!url) return { running: false };
  const [q, stats] = await Promise.all([fetchJSON(`${url}/queue`).catch(() => null), fetchJSON(`${url}/system_stats`).catch(() => null)]);
  return {
    running: true,
    url,
    queueRunning: q?.queue_running?.length || 0,
    queuePending: q?.queue_pending?.length || 0,
    devices: stats?.devices?.map((d) => ({ name: d.name, vramFreeGB: +(d.vram_free / 1e9).toFixed(1), vramTotalGB: +(d.vram_total / 1e9).toFixed(1) })) || [],
    version: stats?.system?.comfyui_version || null,
  };
}

export async function proxyView(query, res) {
  const url = await requireUrl();
  const r = await fetch(`${url}/view?${new URLSearchParams(query)}`);
  const type = r.headers.get('content-type') || 'application/octet-stream';
  const inline = /^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(type);
  res.writeHead(r.status, { 'content-type': type, 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox; default-src none', ...(inline ? {} : { 'content-disposition': 'attachment' }) });
  res.end(Buffer.from(await r.arrayBuffer()));
}

export async function startComfy() {
  return launchProgram('comfyui');
}

export function saveApiWorkflow(name, json) {
  const file = path.join(API_DIR, `${name.replace(/[^\w.-]+/g, '_')}.json`);
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  return file;
}
