// ComfyUI: find the running server, list saved workflows, run them with your changes, collect images.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serviceUrl, comfyWorkflowDirs, comfyDesktop, launchProgram, launchTarget } from './programs.ts';
import type { ComfyPlaces } from './programs.ts';
import { fetchJSON, readJSON, listFiles, dataPath, ensureDir } from './util.ts';
import { getSettings } from './store.ts';
import type { FetchError } from './util.ts';
import { decodePng, encodeAlphaPng, isPng, pngSize } from './png.ts';
import type { ServerResponse } from 'node:http';
import type {
  ComfyNodeError,
  ComfyOutputFile,
  ComfyQueueStatus,
  ComfyResultFile,
  ComfySeed,
  ComfyUploaded,
  PromptNodes,
  RunWorkflowDone,
  RunWorkflowQueued,
} from '../shared/types.ts';

export type {
  ComfyNodeError,
  ComfyOutputFile,
  ComfyQueueStatus,
  ComfyResultFile,
  ComfySeed,
  ComfyUploaded,
  PromptNodes,
  RunWorkflowDone,
  RunWorkflowQueued,
} from '../shared/types.ts';

/** A saved workflow file (ours in data/comfy-workflows, or one from ComfyUI's own folders). */
export interface ComfyWorkflowFile {
  name: string;
  file: string;
  dir: string;
}

/** A node of a workflow in API format (what /prompt takes). Inputs are values or [nodeId, slot] links. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiWorkflow = Record<string, ApiNode>;

/** A workflow as the ComfyUI editor saves it (only the fields used here). */
interface UiNode {
  id: number | string;
  type: string;
  mode?: number;
  title?: string;
  inputs?: { name: string; type?: string; link: number | null; widget?: { name: string } }[];
  outputs?: { name?: string; type?: string }[];
  widgets_values?: unknown[] | Record<string, unknown>;
  /** Files saved since July 2026: every widget's value by its name (dotted names included). */
  widgets_values_named?: Record<string, unknown>;
  properties?: { proxyWidgets?: unknown };
}
// Arrays at the top level ([id, origin, origin slot, target, target slot, type]); objects inside subgraphs.
type UiLink =
  | [number, number | string, number, (number | string)?, number?, unknown?]
  | {
      id: number;
      origin_id: number | string;
      origin_slot: number;
      target_id?: number | string;
      target_slot?: number;
      type?: unknown;
    };
interface UiGraph {
  nodes: UiNode[];
  links?: UiLink[];
}
/** A subgraph's definition: its nodes and links, and the inputs and outputs its instances show. */
interface UiSubgraph extends UiGraph {
  id: string;
  inputs?: { name: string; type?: string }[];
  outputs?: { name: string; type?: string }[];
}
export interface UiWorkflow extends UiGraph {
  definitions?: { subgraphs?: UiSubgraph[] };
}

/** /object_info: every node type's inputs, each [type, options]. */
interface InputOptions {
  forceInput?: boolean;
  control_after_generate?: unknown;
  dynamicPrompts?: boolean;
  image_upload?: boolean;
  video_upload?: boolean;
  audio_upload?: boolean;
  image_folder?: string;
  widgetType?: string;
  /** A dropdown's choices; for a dynamic combo, each choice's key and the inputs it adds. */
  options?: unknown[];
  [k: string]: unknown;
}
type InputSpec = [unknown, InputOptions?];
type InputGroup = { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };
interface NodeDef {
  input?: InputGroup & { hidden?: Record<string, InputSpec> };
  input_order?: { required?: string[]; optional?: string[] };
  display_name?: string;
}
export type ObjectInfo = Record<string, NodeDef>;

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] };
  outputs?: Record<string, Record<string, unknown>>;
}

/** A file to send to ComfyUI for a run: it goes into ComfyUI's input folder, and its name into a loader node. */
export interface ComfyInputImage {
  /** The file on disk (the caller has checked the agent may read it). */
  file: string;
  /** The loader node, as "10" or "10.image". Left out: the workflow's one Load Image node. */
  node?: string;
  /** A PNG mask for the picture, put into its transparency (which Load Image's MASK output reads). */
  mask?: string;
  /** white (the default): white marks the area to repaint. transparent: the mask's transparent pixels do. */
  maskKind?: 'white' | 'transparent';
}

export interface RunWorkflowOptions {
  workflow?: string;
  prompt?: string | null;
  negative?: string | null;
  inputs?: Record<string, unknown>;
  images?: ComfyInputImage[];
  randomizeSeed?: boolean;
  wait?: boolean;
  timeoutSec?: number;
  onProgress?: (seconds: number) => void;
  signal?: AbortSignal | null;
}

const API_DIR = ensureDir(dataPath('comfy-workflows'));

export async function comfyUrl(): Promise<string | null> {
  return serviceUrl('comfyui');
}

/** Whether the ComfyUI the dashboard talks to is on this computer: the address in Settings, when there is one, else
 *  the ports it tries on 127.0.0.1. */
export function onThisComputer(): boolean {
  const set = getSettings().comfyui.url;
  if (!set) return true;
  try {
    const host = new URL(set).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

async function requireUrl(): Promise<string> {
  const url = await comfyUrl();
  if (!url)
    throw new Error(
      'ComfyUI is not running. Start it from Programs (or call launch_program "comfyui"), wait for it to load, then try again.',
    );
  return url;
}

export function listWorkflows(): ComfyWorkflowFile[] {
  const out: ComfyWorkflowFile[] = [];
  for (const dir of [API_DIR, ...comfyWorkflowDirs()]) {
    for (const f of listFiles(dir, (n) => n.endsWith('.json'))) {
      out.push({ name: f.replace(/\.json$/, ''), file: path.join(dir, f), dir });
    }
  }
  return out;
}

function findWorkflow(name: string | undefined): ComfyWorkflowFile | null {
  const all = listWorkflows();
  const n = String(name || '')
    .replace(/\.json$/, '')
    .toLowerCase();
  return all.find((w) => w.name.toLowerCase() === n) || all.find((w) => w.name.toLowerCase().includes(n)) || null;
}

const isApiFormat = (wf: Record<string, unknown>): wf is ApiWorkflow =>
  !!wf && !Array.isArray(wf.nodes) && Object.values(wf).every((n) => n && typeof n === 'object' && 'class_type' in n);

let objectInfoCache: { url: string | null; at: number; data: ObjectInfo | null } = { url: null, at: 0, data: null };
async function objectInfo(url: string): Promise<ObjectInfo> {
  if (objectInfoCache.url === url && Date.now() - objectInfoCache.at < 10 * 60_000) return objectInfoCache.data!;
  const data = await fetchJSON<ObjectInfo>(`${url}/object_info`, { timeout: 30000 });
  objectInfoCache = { url, at: Date.now(), data };
  return data;
}

// ---------- editor files ----------
// The conversion follows ComfyUI's own frontend (graphToPrompt in src/utils/executionUtil.ts and ExecutableNodeDTO in
// src/lib/litegraph/src/subgraph): widget values by name, then links over them; editor-only nodes resolved away;
// subgraphs flattened, their inner nodes named "<instance>:<inner id>".

// Nodes that exist only in the editor (isVirtualNode there).
const VIRTUAL = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote']);
// Input types that are widgets, each keeping one value in widgets_values (ComfyWidgets in src/scripts/widgets.ts).
// The first five are certain; the rest are newer and rarer widgets whose saved values are assumed to work the same.
const WIDGETS = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const OTHER_WIDGETS = new Set([
  'MARKDOWN',
  'COLOR',
  'COLORS',
  'CURVE',
  'RANGE',
  'TEXTAREA',
  'BOUNDING_BOX',
  'BOUNDING_BOXES',
  'PAINTER',
  'COMPOSITOR',
  'VIDEO_EDIT',
  'VIDEO_CONCAT',
  'GALLERIA',
  'CHART',
]);
// A V3 dropdown whose chosen option adds inputs of its own, named "<dropdown>.<input>".
const DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3';
// Where links from a subgraph's inputs start, and links to its outputs end.
const SUBGRAPH_IN = '-10';
const SUBGRAPH_OUT = '-20';

type Ref = [string, number];
type Resolved = { ref: Ref } | { value: unknown } | null;
interface GraphCtx {
  graph: UiGraph;
  /** The subgraph instances this graph is inside, outermost first. */
  path: string[];
  parent: GraphCtx | null;
  instance: UiNode | null;
  def: UiSubgraph | null;
}
interface Link {
  id: number;
  from: string;
  slot: number;
  to: string;
  toSlot: number;
  type: string;
}
const linkOf = (l: UiLink): Link =>
  Array.isArray(l)
    ? {
        id: l[0],
        from: String(l[1]),
        slot: l[2],
        to: String(l[3] ?? ''),
        toSlot: Number(l[4] ?? -1),
        type: typeof l[5] === 'string' ? l[5] : '',
      }
    : {
        id: l.id,
        from: String(l.origin_id),
        slot: l.origin_slot,
        to: String(l.target_id ?? ''),
        toSlot: Number(l.target_slot ?? -1),
        type: typeof l.type === 'string' ? l.type : '',
      };

// A value as the frontend sends it: lists wrapped, so the server doesn't take them for links.
const wire = (v: unknown, type?: unknown): unknown =>
  type === 'CURVE' && v != null ? { __type__: 'CURVE', __value__: v } : Array.isArray(v) ? { __value__: v } : v;

// "IMAGE,MASK" and "*" as the editor matches socket types.
function fits(a?: string, b?: string): boolean {
  if (!a || !b || a === '*' || b === '*') return true;
  const bs = b.toLowerCase().split(',');
  return a
    .toLowerCase()
    .split(',')
    .some((t) => bs.includes(t));
}
// Which input a bypassed node passes on for one of its outputs (_getBypassSlotIndex in the frontend).
function bypassInput(node: UiNode, slot: number, type: string): number {
  const ins = node.inputs || [];
  if (!type || type === '*') return ins[slot] ? slot : ins.length ? 0 : -1;
  const out = node.outputs?.[slot]?.type;
  if (ins[slot] && fits(ins[slot].type, out) && fits(ins[slot].type, type)) return slot;
  const exact = ins.findIndex((i) => i.type === type);
  return exact >= 0 ? exact : ins.findIndex((i) => fits(i.type, out) && fits(i.type, type));
}

interface WidgetSlot {
  name: string;
  spec: InputSpec;
  /** Its place in widgets_values. */
  at: number;
}
// A node type's widgets in the order the editor makes them, each with its place in widgets_values. A seed's "control
// after generate" takes one more place, a dropdown's two (with its filter); a dynamic combo's chosen option adds its
// inputs right after it, required then optional. Files saved before the editor's 1.16 also kept a placeholder for
// inputs that are sockets only (placeholders).
function widgetSlots(
  def: NodeDef,
  read: (name: string, at: number) => unknown,
  placeholders: boolean,
): { slots: WidgetSlot[]; used: number; unsure: Set<string>; uploads: number } {
  const slots: WidgetSlot[] = [];
  const unsure = new Set<string>();
  let at = 0;
  let uploads = 0;
  const ordered = (g: InputGroup, order?: { required?: string[]; optional?: string[] }): [string, InputSpec][] => {
    const pick = (rec: Record<string, InputSpec> | undefined, names?: string[]) =>
      (names?.length ? names.filter((n) => rec && n in rec) : Object.keys(rec || {})).map((n): [string, InputSpec] => [
        n,
        rec![n],
      ]);
    return [...pick(g.required, order?.required), ...pick(g.optional, order?.optional)];
  };
  const walk = (specs: [string, InputSpec][], prefix: string) => {
    for (const [key, spec] of specs) {
      const name = prefix + key;
      const type = spec?.[0];
      const o = spec?.[1] || {};
      if (type === DYNAMIC_COMBO) {
        slots.push({ name, spec, at });
        const chosen = read(name, at++);
        const option = (o.options || []).find(
          (x): x is { key: unknown; inputs?: InputGroup } =>
            !!x && typeof x === 'object' && (x as { key?: unknown }).key === chosen,
        );
        if (option?.inputs) walk(ordered(option.inputs), `${name}.`);
        continue;
      }
      const t = Array.isArray(type)
        ? 'COMBO'
        : typeof o.widgetType === 'string'
          ? o.widgetType
          : typeof type === 'string'
            ? type
            : '';
      if (!WIDGETS.has(t) && !OTHER_WIDGETS.has(t)) {
        // sockets only (IMAGE, MODEL…, and the growing lists of V3 nodes); groups and slots of V3 nodes are unknown ground
        if (/^COMFY_DYNAMIC(GROUP|SLOT)_V3$/.test(t)) unsure.add(t);
        continue;
      }
      if (o.forceInput) {
        if (placeholders) at++;
        continue;
      }
      if (OTHER_WIDGETS.has(t)) unsure.add(t);
      if (o.image_upload || o.video_upload || o.audio_upload) uploads = 1; // the editor adds an upload button last
      slots.push({ name, spec, at: at++ });
      const control =
        t === 'INT' ? (o.control_after_generate ?? ['seed', 'noise_seed'].includes(name)) : o.control_after_generate;
      if (control) at += t === 'COMBO' ? 2 : 1;
    }
  };
  walk(ordered(def.input || {}, def.input_order), '');
  return { slots, used: at, unsure, uploads };
}

/** Turns a workflow saved from the ComfyUI editor into the API format /prompt expects, using the server's node list. */
export function uiToApi(wf: UiWorkflow, info: ObjectInfo): { api: ApiWorkflow; warnings: string[] } {
  const api: ApiWorkflow = {};
  const warnings: string[] = [];
  const defs = new Map(
    (wf.definitions?.subgraphs || [])
      .filter((d) => d && typeof d.id === 'string')
      .map((d): [string, UiSubgraph] => [d.id, d]),
  );
  const linkCache = new WeakMap<UiGraph, Map<number, Link>>();
  const nodeCache = new WeakMap<UiGraph, Map<string, UiNode>>();
  const linksOf = (g: UiGraph) =>
    linkCache.get(g) ||
    (linkCache.set(g, new Map((g.links || []).map((l) => linkOf(l)).map((l): [number, Link] => [l.id, l]))),
    linkCache.get(g)!);
  const nodesOf = (g: UiGraph) =>
    nodeCache.get(g) ||
    (nodeCache.set(g, new Map((g.nodes || []).map((n): [string, UiNode] => [String(n.id), n]))), nodeCache.get(g)!);
  const inside = (ctx: GraphCtx, node: UiNode): GraphCtx => {
    const def = defs.get(node.type)!;
    return { graph: def, path: [...ctx.path, String(node.id)], parent: ctx, instance: node, def };
  };

  // The value a subgraph instance gives one of its inputs when nothing is linked to it: its widgets_values hold one
  // value per promoted input (one whose links reach an inner widget), in the definition's order; older files list
  // them in properties.proxyWidgets instead. An empty place leaves the inner widget's own value.
  const promoted = (ctx: GraphCtx, slot: number): unknown => {
    const inst = ctx.instance!;
    const def = ctx.def!;
    const values = inst.widgets_values;
    if (!Array.isArray(values)) return undefined;
    const proxies = inst.properties?.proxyWidgets;
    if (Array.isArray(proxies)) {
      const i = proxies.findIndex(
        (p) => Array.isArray(p) && String(p[0]) === '-1' && p[1] === def.inputs?.[slot]?.name,
      );
      return i >= 0 ? (values[i] ?? undefined) : undefined;
    }
    const nodes = nodesOf(def);
    const reaches = (s: number) =>
      [...linksOf(def).values()].some(
        (l) =>
          l.from === SUBGRAPH_IN && l.slot === s && !!nodes.get(l.to)?.inputs?.find((i) => i.link === l.id)?.widget,
      );
    const order = (def.inputs || []).map((_, s) => s).filter(reaches);
    const k = order.indexOf(slot);
    return k >= 0 ? (values[k] ?? undefined) : undefined;
  };

  const resolveLink = (ctx: GraphCtx | null, linkId: number | null | undefined, guard: number): Resolved => {
    const l = ctx && linkId != null ? linksOf(ctx.graph).get(linkId) : null;
    return ctx && l ? resolveOutput(ctx, l.from, l.slot, l.type, guard + 1) : null;
  };
  // What feeds an input: a node's output ([id, slot]), a value (a PrimitiveNode's, a subgraph's promoted widget's),
  // or nothing (muted, unlinked).
  const resolveOutput = (ctx: GraphCtx, from: string, slot: number, type: string, guard: number): Resolved => {
    if (guard > 200) return null;
    if (from === SUBGRAPH_IN) {
      if (!ctx.instance || !ctx.def || !ctx.parent) return null;
      const name = ctx.def.inputs?.[slot]?.name;
      const outer = ctx.instance.inputs?.find((i) => i.name === name) ?? ctx.instance.inputs?.[slot];
      if (outer?.link != null) return resolveLink(ctx.parent, outer.link, guard);
      const v = promoted(ctx, slot);
      return v === undefined ? null : { value: v };
    }
    const src = nodesOf(ctx.graph).get(from);
    if (!src || src.mode === 2) return null;
    if (src.mode === 4) {
      const i = bypassInput(src, slot, type);
      return i >= 0 ? resolveLink(ctx, src.inputs?.[i]?.link, guard) : null;
    }
    if (defs.has(src.type)) {
      if (ctx.path.length >= 16) return null;
      const sub = inside(ctx, src);
      const l = [...linksOf(sub.graph).values()].find((x) => x.to === SUBGRAPH_OUT && x.toSlot === slot);
      return l ? resolveOutput(sub, l.from, l.slot, type, guard + 1) : null;
    }
    if (src.type === 'Reroute') return resolveLink(ctx, src.inputs?.find((i) => i.link != null)?.link, guard);
    if (src.type === 'PrimitiveNode')
      return { value: Array.isArray(src.widgets_values) ? src.widgets_values[0] : undefined };
    if (VIRTUAL.has(src.type)) return null;
    return { ref: [[...ctx.path, String(src.id)].join(':'), slot] };
  };

  const convert = (ctx: GraphCtx, node: UiNode, id: string, def: NodeDef) => {
    const inputs: Record<string, unknown> = {};
    const values = node.widgets_values;
    const named =
      node.widgets_values_named || (values && !Array.isArray(values) && typeof values === 'object' ? values : null);
    const list = Array.isArray(values) ? values : [];
    let w = widgetSlots(def, (name, at) => (named ? named[name] : list[at]), false);
    if (!named) {
      const fit = (x: typeof w) => list.length === x.used || list.length === x.used + x.uploads;
      const old = widgetSlots(def, (_name, at) => list[at], true);
      if (!fit(w) && fit(old)) w = old;
      if (w.unsure.size)
        warnings.push(
          `Node ${id} (${node.type}) has inputs of a kind (${[...w.unsure].join(', ')}) whose saved values the dashboard places by assumption; if ComfyUI rejects them, save the workflow with File › Export (API) and run that.`,
        );
    }
    for (const s of w.slots) {
      const v = named ? named[s.name] : list[s.at];
      if (v === undefined) continue;
      inputs[s.name] = wire(v, s.spec[0]);
      if (s.spec[1]?.dynamicPrompts && typeof v === 'string' && /\{[^{}]*\|[^{}]*\}/.test(v))
        warnings.push(
          `Node ${id}'s ${s.name} has {a|b} choices, which ComfyUI's editor picks from before it runs; the dashboard sends the text as it is.`,
        );
    }
    // an older file's subgraph instance can set its inner widgets directly (properties.proxyWidgets)
    const proxies = ctx.instance?.properties?.proxyWidgets;
    const own = ctx.instance?.widgets_values;
    if (Array.isArray(proxies) && Array.isArray(own)) {
      proxies.forEach((p, i) => {
        if (
          Array.isArray(p) &&
          String(p[0]) === String(node.id) &&
          typeof p[1] === 'string' &&
          own[i] !== undefined &&
          own[i] !== null
        )
          inputs[p[1]] = wire(own[i]);
      });
    }
    // links win over widget values; one that leads nowhere leaves the widget's value (and a plain socket out)
    for (const inp of node.inputs || []) {
      if (inp.link == null) continue;
      const r = resolveLink(ctx, inp.link, 0);
      if (r) inputs[inp.name] = 'ref' in r ? r.ref : wire(r.value);
    }
    api[id] = { class_type: node.type, inputs, _meta: { title: node.title || def.display_name || node.type } };
  };

  const emit = (ctx: GraphCtx) => {
    for (const node of ctx.graph.nodes || []) {
      if (node.mode === 2 || node.mode === 4) continue; // muted or bypassed (a subgraph's with all inside it)
      const id = [...ctx.path, String(node.id)].join(':');
      if (defs.has(node.type)) {
        if (ctx.path.length >= 16) warnings.push(`Subgraph ${id} is nested too deep to convert.`);
        else emit(inside(ctx, node));
        continue;
      }
      if (VIRTUAL.has(node.type)) continue;
      const def = info[node.type];
      if (def) convert(ctx, node, id, def);
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.type))
        warnings.push(
          `Node ${id} is a subgraph whose definition isn't in the file; save the workflow again in ComfyUI, or use File › Export (API).`,
        );
      else if (/^workflow[>/]/.test(node.type))
        warnings.push(
          `Node ${id} (${node.type}) is an old-style group node, which the dashboard can't convert: in ComfyUI, turn it into a subgraph, or save the workflow with File › Export (API).`,
        );
      else warnings.push(`Node ${id} (${node.type}) is not known to this ComfyUI.`);
    }
  };
  emit({ graph: wf, path: [], parent: null, instance: null, def: null });
  // as the frontend does: a link to a node that isn't sent (unknown, or left out) is dropped
  for (const n of Object.values(api))
    for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && !(String(v[0]) in api)) delete n.inputs[k];
  return { api, warnings };
}

async function loadApiWorkflow(
  name: string | undefined,
  url: string,
): Promise<{ api: ApiWorkflow; warnings: string[]; workflow: ComfyWorkflowFile }> {
  const w = findWorkflow(name);
  if (!w)
    throw new Error(
      `No ComfyUI workflow called "${name}". Available: ${
        listWorkflows()
          .map((x) => x.name)
          .join(', ') || 'none'
      }.`,
    );
  const raw = readJSON<Record<string, unknown>>(w.file);
  if (!raw) throw new Error(`Couldn't read ${w.file}.`);
  if (isApiFormat(raw)) return { api: raw, warnings: [], workflow: w };
  if (!Array.isArray(raw.nodes)) throw new Error(`${w.name} is not a ComfyUI workflow file.`);
  const { api, warnings } = uiToApi(raw as unknown as UiWorkflow, await objectInfo(url));
  return { api, warnings, workflow: w };
}

// What can be changed in a workflow: every node's plain inputs, keyed "nodeId.input".
export async function describeWorkflow(name: string | undefined) {
  const url = await requireUrl();
  const { api, warnings, workflow } = await loadApiWorkflow(name, url);
  const editable: Record<string, { node: string; value: unknown }> = {};
  for (const [id, n] of Object.entries(api)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!Array.isArray(v))
        editable[`${id}.${k}`] = {
          node: n._meta?.title || n.class_type,
          value: typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v,
        };
    }
  }
  return { workflow: workflow.name, file: workflow.file, prompts: findPromptNodes(api), editable, warnings };
}

// The text inputs of the nodes that turn a prompt into conditioning: CLIPTextEncode's text, SDXL's text_g and
// text_l, Flux's clip_l and t5xxl, SD3's and HiDream's clip_g (and HiDream's llama), the newer encoders' prompt.
const TEXT_INPUTS = ['text', 'text_g', 'text_l', 'clip_l', 'clip_g', 't5xxl', 'llama', 'prompt'];
// Inputs that carry conditioning (KSampler's positive, a guider's conditioning, ConditioningCombine's conditioning_1…).
const CONDITIONING_IN = /^(positive|negative|conditioning|cond\d*|conditioning_\w+|cond_\w+)$/;
const isLink = (v: unknown): v is [string | number, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  (typeof v[0] === 'string' || typeof v[0] === 'number') &&
  typeof v[1] === 'number';

// Which text nodes the samplers and guiders get their conditioning from. Starts at each node that takes
// conditioning without passing it on (KSampler, SamplerCustom, CFGGuider, BasicGuider's one conditioning…) and
// follows the link back, through helpers such as FluxGuidance or ControlNet apply, to the text node.
export function findPromptNodes(api: ApiWorkflow): PromptNodes {
  const fed = new Set<string>();
  for (const n of Object.values(api))
    for (const [k, v] of Object.entries(n.inputs || {}))
      if (CONDITIONING_IN.test(k) && isLink(v)) fed.add(String(v[0]));
  const starts = Object.entries(api)
    .filter(
      ([id, n]) => !fed.has(id) && ['positive', 'negative', 'conditioning', 'cond1'].some((k) => isLink(n.inputs?.[k])),
    )
    .sort(
      ([, a], [, b]) => Number(/sampler|guider/i.test(b.class_type)) - Number(/sampler|guider/i.test(a.class_type)),
    );

  // the keys to set on a text node; a text input linked to a string node (PrimitiveStringMultiline…) is set there
  const keysOf = (id: string): string[] => {
    const n = api[id];
    return TEXT_INPUTS.flatMap((k) => {
      const v = n.inputs[k];
      if (typeof v === 'string') return [`${id}.${k}`];
      if (!isLink(v)) return [];
      const src = api[String(v[0])];
      const field = src && ['value', 'string', 'text', 'prompt'].find((f) => typeof src.inputs?.[f] === 'string');
      return field ? [`${String(v[0])}.${field}`] : [];
    });
  };
  const trace = (from: [string | number, number], role: 'positive' | 'negative'): string | null => {
    let id = String(from[0]);
    for (let i = 0; i < 20; i++) {
      const n = api[id];
      if (!n) return null;
      // an empty negative made from the positive one (as Flux workflows do) is no negative prompt
      if (role === 'negative' && n.class_type === 'ConditioningZeroOut') return null;
      if (TEXT_INPUTS.some((k) => typeof n.inputs?.[k] === 'string' || isLink(n.inputs?.[k]))) return id;
      const inputs = n.inputs || {};
      const next = [role, 'conditioning', ...Object.keys(inputs).filter((k) => CONDITIONING_IN.test(k))]
        .map((k) => inputs[k])
        .find(isLink);
      if (!next) return null;
      id = String(next[0]);
    }
    return null;
  };

  const found = { positive: [] as string[], negative: [] as string[] };
  for (const [, n] of starts) {
    const pos = ['positive', 'conditioning', 'cond1'].map((k) => n.inputs[k]).find(isLink);
    const neg = n.inputs.negative;
    const p = pos && trace(pos, 'positive');
    const q = isLink(neg) ? trace(neg, 'negative') : null;
    if (p && !found.positive.includes(p)) found.positive.push(p);
    if (q && !found.negative.includes(q)) found.negative.push(q);
  }
  // one text node feeding both is the prompt: setting the negative there would overwrite it
  const negative = found.negative.filter((id) => !found.positive.includes(id));
  const promptInputs = [...new Set(found.positive.flatMap(keysOf))];
  return {
    positive: found.positive[0] || null,
    negative: negative[0] || null,
    promptInputs,
    negativeInputs: [...new Set(negative.flatMap(keysOf))].filter((k) => !promptInputs.includes(k)),
  };
}

export function runWorkflow(opts: RunWorkflowOptions & { wait: false }): Promise<RunWorkflowQueued>;
export function runWorkflow(opts?: RunWorkflowOptions & { wait?: true }): Promise<RunWorkflowDone>;
export function runWorkflow(opts?: RunWorkflowOptions): Promise<RunWorkflowQueued | RunWorkflowDone>;
export async function runWorkflow({
  workflow,
  prompt,
  negative,
  inputs = {},
  images = [],
  randomizeSeed = true,
  wait = true,
  timeoutSec = 600,
  onProgress,
  signal,
}: RunWorkflowOptions = {}): Promise<RunWorkflowQueued | RunWorkflowDone> {
  // Stop counts at every step before the work is sent: no file goes over and nothing is queued after it
  const halt = () => {
    if (signal?.aborted) throw new Error('Stopped.');
  };
  halt();
  const url = await requireUrl();
  halt();
  const { api, warnings, workflow: w } = await loadApiWorkflow(workflow, url);
  halt();
  const p = findPromptNodes(api);
  if (prompt != null) {
    if (!p.promptInputs.length)
      throw new Error(
        'Could not find where the prompt text goes; set it with inputs {"<nodeId>.text": "..."} (see comfyui_describe_workflow).',
      );
    for (const key of p.promptInputs) setInput(api, key, prompt);
  }
  if (negative != null) {
    if (p.negativeInputs.length) for (const key of p.negativeInputs) setInput(api, key, negative);
    else
      warnings.push(
        'This workflow has no negative prompt to set (its sampler or guider takes one conditioning, or an emptied one), so the negative text was not used.',
      );
  }
  for (const [key, value] of Object.entries(inputs || {})) setInput(api, key, value);
  // where each file goes is settled before anything is sent
  const targets = images.length ? await imageTargets(api, images, url) : [];
  const uploaded: ComfyUploaded[] = [];
  for (const t of targets) {
    halt();
    const value = await sendImage(url, t, signal ?? undefined);
    setInput(api, t.key, value);
    uploaded.push({ file: t.image.file, ...(t.image.mask ? { mask: t.image.mask } : {}), value, input: t.key });
  }
  if (randomizeSeed) {
    for (const [id, n] of Object.entries(api)) {
      for (const k of ['seed', 'noise_seed'])
        if (typeof n.inputs[k] === 'number' && !(`${id}.${k}` in inputs))
          n.inputs[k] = Math.floor(Math.random() * 2 ** 48);
    }
  }
  // the seeds as sent, so a picture worth keeping can be made again
  const seeds: ComfySeed[] = [];
  for (const [id, n] of Object.entries(api)) {
    for (const k of ['seed', 'noise_seed']) {
      const value = n.inputs[k];
      if (typeof value === 'number') seeds.push({ node: id, title: n._meta?.title || n.class_type, input: k, value });
    }
  }
  for (const n of Object.values(api)) delete n._meta;
  halt();
  const clientId = crypto.randomUUID();
  const res = await fetchJSON<{ prompt_id: string; node_errors?: Record<string, ComfyNodeError> }>(`${url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: api, client_id: clientId }),
    timeout: 30000,
  }).catch((e: FetchError) => {
    const body = e.body as { node_errors?: unknown } | undefined;
    const err = body?.node_errors ? `${e.message}\n${JSON.stringify(body.node_errors).slice(0, 1500)}` : e.message;
    throw new Error(`ComfyUI rejected the workflow: ${err}`);
  });
  const promptId = res.prompt_id;
  // (Stop while it was being sent: ComfyUI took it, so it is taken back out of the queue)
  if (signal?.aborted) {
    if (promptId) await cancelPrompt(url, promptId);
    throw new Error('Stopped.');
  }
  // A 200 answer can still list nodes that failed: ComfyUI runs the outputs that passed and drops the rest.
  const nodeErrors = res.node_errors && typeof res.node_errors === 'object' ? res.node_errors : {};
  if (!wait) return { promptId, queued: true as const, seeds, warnings, uploaded, nodeErrors };
  const started = Date.now();
  while (Date.now() - started < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) {
      await cancelPrompt(url, promptId);
      throw new Error('Stopped.');
    }
    const hist = await fetchJSON<Record<string, HistoryEntry>>(`${url}/history/${promptId}`, { timeout: 15000 }).catch(
      () => null,
    );
    const entry = hist?.[promptId];
    if (entry?.status?.status_str === 'error') {
      const msg = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1];
      throw new Error(`ComfyUI failed: ${msg?.exception_message || 'see the ComfyUI console'}`);
    }
    if (entry?.outputs && (entry.status?.completed || Object.keys(entry.outputs).length)) {
      return {
        promptId,
        workflow: w.name,
        files: outputFiles(entry.outputs),
        seconds: Math.round((Date.now() - started) / 1000),
        seeds,
        warnings,
        uploaded,
        nodeErrors,
      };
    }
    onProgress?.(Math.round((Date.now() - started) / 1000));
  }
  throw new Error(`Still running after ${timeoutSec}s (prompt ${promptId}). Check ComfyUI.`);
}

// "12.resize_type.width": node 12, input "resize_type.width" (newer nodes' inputs have dots in their names).
function setInput(api: ApiWorkflow, key: string, value: unknown): void {
  const [id, ...rest] = key.split('.');
  if (!api[id]) throw new Error(`Workflow has no node ${id}.`);
  api[id].inputs[rest.join('.')] = value;
}

const FILE_KINDS = ['images', 'gifs', 'videos', 'audio', '3d'];
const MODEL_3D = /\.(glb|gltf|obj|fbx|stl|usdz|ply|spz|splat|ksplat)$/i;
// The files in a finished job's outputs. 3D nodes list theirs under "3d" (SaveGLB, Save3DAdvanced, the 3D
// previews); the old Preview 3D node gives a path in its output folder as result[0], which its page loads from there.
function outputFiles(outputs: Record<string, Record<string, unknown>>): ComfyResultFile[] {
  const files: ComfyResultFile[] = [];
  const add = (f: ComfyOutputFile, kind: string) => {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
    files.push({ ...f, kind, url: `/api/comfyui/view?${q}` });
  };
  for (const out of Object.values(outputs)) {
    if (!out || typeof out !== 'object') continue;
    for (const kind of FILE_KINDS) {
      const list = out[kind];
      if (Array.isArray(list))
        for (const f of list)
          if (f && typeof f === 'object' && typeof (f as ComfyOutputFile).filename === 'string')
            add(f as ComfyOutputFile, kind);
    }
    const result = Array.isArray(out.result) ? out.result[0] : null;
    if (!Array.isArray(out['3d']) && typeof result === 'string' && MODEL_3D.test(result)) {
      const rel = result.replace(/\\/g, '/');
      add(
        {
          filename: path.posix.basename(rel),
          subfolder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          type: 'output',
        },
        '3d',
      );
    }
  }
  return files;
}

/** The node errors of a /prompt answer, one line each, for an agent to read. */
export function describeNodeErrors(errors: Record<string, ComfyNodeError>): string[] {
  return Object.entries(errors).map(([id, e]) => {
    const why = (e.errors || []).map(
      (x) =>
        `${x.type ? `${x.type}: ` : ''}${x.message || 'failed'}${x.details ? ` (${x.details})` : ''}${x.extra_info?.input_name ? ` [input "${x.extra_info.input_name}"]` : ''}`,
    );
    const outs = e.dependent_outputs?.length
      ? `, so output node${e.dependent_outputs.length > 1 ? 's' : ''} ${e.dependent_outputs.join(', ')} didn't run`
      : '';
    return `node ${id}${e.class_type ? ` (${e.class_type})` : ''} failed ComfyUI's checks${outs}: ${why.join('; ') || 'no reason given'}`;
  });
}

// ---------- input files ----------

// The input of a node that takes an uploaded file (Load Image's image, Load Video's file, Load Audio's audio),
// from the upload flags /object_info gives. Load Image (from Outputs) reads the output folder, so it doesn't count.
function uploadInput(node: ApiNode, info: ObjectInfo | null, imagesOnly: boolean): string | null {
  const def = info?.[node.class_type];
  if (!def) return ['LoadImage', 'LoadImageMask'].includes(node.class_type) ? 'image' : null;
  const specs = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
  const hit = specs.find(([, s]) => {
    const o = s?.[1];
    return (
      !!o &&
      o.image_folder !== 'output' &&
      (o.image_upload === true || (!imagesOnly && (o.video_upload === true || o.audio_upload === true)))
    );
  });
  return hit ? hit[0] : null;
}

type ImageTarget = { image: ComfyInputImage; key: string; mask: ReturnType<typeof maskPng> | null };
async function imageTargets(api: ApiWorkflow, images: ComfyInputImage[], url: string): Promise<ImageTarget[]> {
  const info = await objectInfo(url).catch(() => null);
  const loaders = Object.entries(api).filter(([, n]) => uploadInput(n, info, true));
  const named = (id: string) => `${id} (${api[id]._meta?.title || api[id].class_type})`;
  const out: ImageTarget[] = [];
  for (const image of images) {
    if (image.mask && image.maskKind && !['white', 'transparent'].includes(image.maskKind))
      throw new Error(`mask_kind is "white" or "transparent", not "${image.maskKind}".`);
    const mask = image.mask
      ? maskPng(fs.readFileSync(image.mask), image.maskKind || 'white', path.basename(image.mask))
      : null;
    const size = mask && pngSize(fs.readFileSync(image.file));
    if (mask && size && (size.width !== mask.width || size.height !== mask.height))
      throw new Error(
        `The mask is ${mask.width}x${mask.height} but the picture is ${size.width}x${size.height}; they have to be the same size.`,
      );
    let key: string;
    if (image.node) {
      const [id, ...rest] = String(image.node).split('.');
      if (!api[id]) throw new Error(`Workflow has no node ${id}.`);
      const input = rest.join('.') || uploadInput(api[id], info, false);
      if (!input)
        throw new Error(
          `Node ${named(id)} doesn't load a file. Give the input too, as "${id}.<input>", or pick a Load Image node${loaders.length ? `: ${loaders.map(([lid]) => named(lid)).join(', ')}` : ''}.`,
        );
      key = `${id}.${input}`;
    } else {
      if (loaders.length !== 1)
        throw new Error(
          loaders.length
            ? `This workflow has ${loaders.length} Load Image nodes: ${loaders.map(([lid]) => named(lid)).join(', ')}. Say which one each picture goes into with node.`
            : 'This workflow has no Load Image node to put the picture into.',
        );
      key = `${loaders[0][0]}.${uploadInput(loaders[0][1], info, true)}`;
    }
    if (out.some((t) => t.key === key)) throw new Error(`Two pictures go into ${key}; give each its own node.`);
    out.push({ image, key, mask });
  }
  return out;
}

async function upload(
  url: string,
  route: string,
  filename: string,
  bytes: Buffer,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(bytes)]), filename);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const r = await fetchJSON<{ name?: unknown; subfolder?: unknown }>(`${url}${route}`, {
    method: 'POST',
    body: form,
    signal: signal ? AbortSignal.any([AbortSignal.timeout(120000), signal]) : AbortSignal.timeout(120000),
  });
  if (!r || typeof r.name !== 'string') throw new Error(`ComfyUI's answer to ${filename} had no file name in it.`);
  // what a loader node's input takes: "subfolder/name" when it went into a subfolder
  return typeof r.subfolder === 'string' && r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

// One picture into ComfyUI's input folder, and its mask onto it. ComfyUI renames an upload rather than replace a
// different file of the same name, so the name it gives back is the one to use. The masked copy is a new file named
// after the picture; the picture itself stays as it was.
async function sendImage(url: string, { image, mask }: ImageTarget, signal?: AbortSignal): Promise<string> {
  const value = await upload(
    url,
    '/upload/image',
    path.basename(image.file),
    fs.readFileSync(image.file),
    { type: 'input' },
    signal,
  ).catch((e: Error) => {
    if (signal?.aborted) throw new Error('Stopped.');
    throw new Error(`ComfyUI didn't take ${path.basename(image.file)}: ${e.message}`);
  });
  if (!mask) return value;
  if (signal?.aborted) throw new Error('Stopped.');
  const slash = value.lastIndexOf('/');
  const ref = { filename: value.slice(slash + 1), subfolder: slash > 0 ? value.slice(0, slash) : '', type: 'input' };
  return upload(
    url,
    '/upload/mask',
    `${ref.filename.replace(/\.[^.]+$/, '')}-mask.png`,
    mask.png,
    { type: 'input', subfolder: ref.subfolder, original_ref: JSON.stringify(ref) },
    signal,
  ).catch((e: Error) => {
    if (signal?.aborted) throw new Error('Stopped.');
    throw new Error(`ComfyUI couldn't put the mask onto ${value} (the two have to be the same size): ${e.message}`);
  });
}

/** A mask as ComfyUI's /upload/mask takes it: a PNG whose transparent pixels mark the area to repaint (it copies
 *  that transparency into the picture, and Load Image's MASK output is 1 where the picture is transparent). */
export function maskPng(
  bytes: Buffer,
  kind: 'white' | 'transparent',
  name: string,
): { png: Buffer; width: number; height: number } {
  if (!isPng(bytes)) throw new Error(`${name}: a mask has to be a PNG file.`);
  let px: ReturnType<typeof decodePng>;
  try {
    px = decodePng(bytes);
  } catch (e) {
    throw new Error(`${name} can't be read as a mask: ${(e as Error).message}.`);
  }
  if (kind === 'transparent' && !px.hasAlpha)
    throw new Error(`${name} has no transparency. For a black-and-white mask, leave mask_kind out (white).`);
  const alpha = kind === 'white' ? px.grey.map((g) => 255 - g) : px.alpha;
  if (alpha.every((a) => a === 255))
    throw new Error(
      `${name} marks nothing to repaint (it has no ${kind === 'white' ? 'white' : 'transparent'} pixels).`,
    );
  return { png: encodeAlphaPng(px.width, px.height, alpha), width: px.width, height: px.height };
}

/** Takes one job off ComfyUI: out of the queue, and interrupted only when it is the one running now
 *  (an interrupt stops whatever runs, which may be someone else's job). */
export async function cancelPrompt(url: string, promptId: string): Promise<void> {
  const json = { 'content-type': 'application/json' };
  await fetch(`${url}/queue`, { method: 'POST', headers: json, body: JSON.stringify({ delete: [promptId] }) }).catch(
    () => {},
  );
  const q = await fetchJSON<{ queue_running?: unknown[][] }>(`${url}/queue`, { timeout: 10000 }).catch(() => null);
  if (!q?.queue_running?.some((job) => Array.isArray(job) && job[1] === promptId)) return;
  // (newer ComfyUI interrupts only the prompt named; older ones the running one, which is this one)
  await fetch(`${url}/interrupt`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ prompt_id: promptId }),
  }).catch(() => {});
}

export async function queueStatus(): Promise<ComfyQueueStatus> {
  const url = await comfyUrl();
  if (!url) return { running: false };
  const [q, stats] = await Promise.all([
    fetchJSON<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(`${url}/queue`).catch(() => null),
    fetchJSON<{
      devices?: { name: string; vram_free: number; vram_total: number }[];
      system?: { comfyui_version?: string };
    }>(`${url}/system_stats`).catch(() => null),
  ]);
  return {
    running: true,
    url,
    queueRunning: q?.queue_running?.length || 0,
    queuePending: q?.queue_pending?.length || 0,
    devices:
      stats?.devices?.map((d) => ({
        name: d.name,
        vramFreeGB: +(d.vram_free / 1e9).toFixed(1),
        vramTotalGB: +(d.vram_total / 1e9).toFixed(1),
      })) || [],
    version: stats?.system?.comfyui_version || null,
  };
}

export async function proxyView(query: Record<string, string>, res: ServerResponse): Promise<void> {
  const url = await requireUrl();
  const r = await fetch(`${url}/view?${new URLSearchParams(query)}`);
  const type = r.headers.get('content-type') || 'application/octet-stream';
  const inline = /^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(type);
  res.writeHead(r.status, {
    'content-type': type,
    'cache-control': 'max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox; default-src none',
    ...(inline ? {} : { 'content-disposition': 'attachment' }),
  });
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** A result picture's bytes (a /api/comfyui/view link's filename, subfolder and type), for a model to see.
 *  Only PNG, JPEG, WebP or GIF up to max bytes; else null. */
export async function viewImage(link: string, max: number): Promise<{ mime: string; bytes: Buffer } | null> {
  const m = /^\/api\/comfyui\/view\?(.*)$/s.exec(link);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const url = await comfyUrl();
  if (!url || !q.get('filename')) return null;
  const r = await fetch(
    `${url}/view?${new URLSearchParams({ filename: q.get('filename') || '', subfolder: q.get('subfolder') || '', type: q.get('type') || 'output' })}`,
    { signal: AbortSignal.timeout(30000) },
  );
  const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!r.ok || !/^image\/(png|jpeg|webp|gif)$/.test(mime) || Number(r.headers.get('content-length') || 0) > max)
    return null;
  const bytes = Buffer.from(await r.arrayBuffer());
  return bytes.length && bytes.length <= max ? { mime, bytes } : null;
}

/** What the new Comfy Desktop does when it opens, from its settings: whether it starts a ComfyUI on this computer,
 *  and what to tell the user when none comes up. null when that Desktop isn't on this computer. */
export function desktopStartup(at?: ComfyPlaces): { startsServer: boolean; note: string } | null {
  const { installs, settings } = comfyDesktop(at);
  if (!settings) return null;
  const launch =
    'Ask the user to press Launch on their ComfyUI in Comfy Desktop (or to set its Settings › Auto-launch on startup to "Last used instance", so it starts with Desktop from now on), then check with comfyui_status.';
  // Desktop reads the setting only once its first-run setup is done (openStartupSurface in its src/main/index.ts)
  if (settings.firstUseCompleted !== true)
    return {
      startsServer: false,
      note: "Comfy Desktop opened, but it isn't set up yet: it shows its first-run screens and starts nothing until the user finishes them (choosing or installing a ComfyUI). Ask them to finish that, then check with comfyui_status.",
    };
  const choice = settings.autoLaunchOnStartup;
  if (!choice || choice === 'none')
    return {
      startsServer: false,
      note: `Comfy Desktop opened on its dashboard. It starts a ComfyUI by itself only when its "Auto-launch on startup" setting names one, and that setting is off. ${launch}`,
    };
  const inst =
    choice === 'last'
      ? installs
          .filter((r) => typeof r.lastLaunchedAt === 'number')
          .sort((a, b) => b.lastLaunchedAt! - a.lastLaunchedAt!)[0]
      : installs.find((r) => r.id === choice);
  if (!inst)
    return {
      startsServer: false,
      note: `Comfy Desktop opened on its dashboard: its "Auto-launch on startup" setting names ${choice === 'last' ? 'the last used ComfyUI, but none has been launched from it yet' : 'a ComfyUI that is no longer there'}. ${launch}`,
    };
  const name = inst.name ? `"${inst.name}"` : 'a ComfyUI';
  if (['cloud', 'remote'].includes(inst.sourceId || ''))
    return {
      startsServer: false,
      note: `Comfy Desktop is set to open ${name} when it starts, which runs ${inst.sourceId === 'cloud' ? 'on Comfy Cloud' : 'on another computer'}, not here. ${launch}`,
    };
  return {
    startsServer: true,
    note: `Comfy Desktop is set to start ${name} when it opens, but it hasn't answered yet. A first start or an update can take a few minutes: check again with comfyui_status. If Comfy Desktop was already open, starting it again only brings its window forward, so ask the user to press Launch there.`,
  };
}

/** Starts ComfyUI (its desktop app, or what Settings › ComfyUI path names). With waitSec, waits that long for it to
 *  answer and says what happened, and what the user may need to do. */
export async function startComfy({
  waitSec = 0,
  signal,
  onProgress,
}: { waitSec?: number; signal?: AbortSignal | null; onProgress?: (seconds: number) => void } = {}): Promise<string> {
  const up = await comfyUrl();
  if (up) return `ComfyUI is already running at ${up}.`;
  const started = await launchProgram('comfyui');
  if (!waitSec) return started;
  // a .bat or script (the portable build) is ComfyUI itself, not Comfy Desktop
  const target = launchTarget('comfyui', false);
  const desk = /\.(bat|cmd|ps1|sh|py|command)$/i.test(target?.exe || target?.shortcut || '') ? null : desktopStartup();
  // when Desktop won't start one, a short look in case its settings changed since, then say why
  const limit = desk && !desk.startsServer ? Math.min(waitSec, 10) : waitSec;
  const t0 = Date.now();
  while (Date.now() - t0 < limit * 1000 && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 2000));
    const url = await comfyUrl();
    const s = Math.round((Date.now() - t0) / 1000);
    if (url) return `${started} ComfyUI is running at ${url} (it took ${s} s).`;
    onProgress?.(s);
  }
  if (signal?.aborted) return `${started} Stopped waiting for it to answer.`;
  return `${started} ${desk?.note || `It hasn't answered within ${limit} s; it may still be loading, so check again with comfyui_status in a minute. If it runs at an address other than 127.0.0.1:8188 or :8000, that address goes in Settings › ComfyUI address.`}`;
}

export function saveApiWorkflow(name: string, json: unknown): string {
  const file = path.join(API_DIR, `${name.replace(/[^\w.-]+/g, '_')}.json`);
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  return file;
}
