// Context estimates and admission checks. Each engine owns its active memory.
import { getSettings } from './store.ts';
import { PROVIDERS } from './providers.ts';
import type { ProviderId } from '../shared/types.ts';
import { memoryStart } from '../shared/context.ts';
import { defaultModelForEngine } from '../shared/modeldefaults.ts';
import type { Agent, Chat, ChatItem } from '../shared/types.ts';

const isWord = (c: number): boolean =>
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c === 95 ||
  (c >= 0xc0 && c <= 0x24f) ||
  (c >= 0x370 && c <= 0x52f) ||
  (c >= 0x590 && c <= 0x6ff);
const isSpace = (c: number): boolean => c <= 32 || c === 0xa0 || (c >= 0x2000 && c <= 0x200b) || c === 0x3000;
const isEmoji = (c: number): boolean => (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf);
// What one character adds, given how long the word it continues is so far.
const charCost = (c: number, run: number): number =>
  isWord(c) ? (run % 4 === 0 ? 1 : 0) : isSpace(c) ? 0 : isEmoji(c) ? 2 : 1;

export function estimateTokens(input: unknown): number {
  const s = typeof input === 'string' ? input : input == null ? '' : String(input);
  let n = 0;
  let run = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += charCost(c, run);
    run = isWord(c) ? run + 1 : 0;
  }
  return n;
}

/** How much room an item takes in the agent's memory, word for word. */
export function itemTokens(it: ChatItem): number {
  if (it.type === 'user' || it.type === 'steer' || it.type === 'assistant' || it.type === 'error')
    return estimateTokens(it.text) + 4;
  if (it.type === 'tool')
    return (
      estimateTokens(it.name) +
      estimateTokens(it.args == null ? '' : typeof it.args === 'string' ? it.args : JSON.stringify(it.args)) +
      estimateTokens(it.result || '') +
      8
    );
  return 0; // meta and compaction markers are not sent to the agent
}

export function itemsTokens(items: ChatItem[], from = 0, to = items.length): number {
  let n = 0;
  for (let i = Math.max(0, from); i < to; i++) n += itemTokens(items[i]);
  return n;
}

// ---------- where the agent's memory of a chat starts ----------
export { memoryStart } from '../shared/context.ts';

// ---------- how big the memory is, and how big it may get ----------
// What each engine adds on its own (its system prompt and tool list) that the chat doesn't show.
const ENGINE_OVERHEAD: Record<string, number> = {
  'claude-code': 18_000,
  codex: 12_000,
  hermes: 8_000,
  pi: 4_000,
  omp: 12_000,
  openclaw: 10_000,
  opencode: 10_000,
  eve: 1_000,
};

type ModelOf = Pick<Agent, 'engine' | 'model' | 'provider'>;

/** Who measures a chat's memory: a measurement by another engine, provider or model doesn't apply. */
// (an API-model agent's is the model it really uses, its default when none is set, at the address it is asked at:
// the same name at another address can be another model, with another window)
export const measuredBy = (agent: ModelOf): string => {
  if (agent.engine !== 'eve') return `${agent.engine}||${agent.model || ''}`;
  const provider = String(agent.provider || 'openrouter');
  const model = agent.model || defaultModelForEngine('eve', getSettings().defaults, provider);
  return `eve|${provider}|${PROVIDERS[provider as ProviderId]?.base() || ''}|${model}`;
};
const measurement = (chat: Chat | null | undefined, agent: ModelOf) =>
  chat?.context && chat.context.by === measuredBy(agent) ? chat.context : null;

/** How full the agent's memory of this chat is, in tokens: what the engine last said plus what came
 *  since, or else an estimate from the chat itself. */
export function memoryTokens(chat: Chat, agent: ModelOf, systemPrompt = ''): number {
  const engine = agent.engine;
  const items = chat.items;
  const c = measurement(chat, agent);
  if (c && c.tokens > 0 && c.items <= items.length) return c.tokens + itemsTokens(items, c.items);
  const start = memoryStart(items);
  return estimateTokens(systemPrompt) + (ENGINE_OVERHEAD[engine] ?? 4_000) + itemsTokens(items, start);
}

const windows = new Map<string, { at: number; models: Map<string, number> }>();

/** The model's context window in tokens: what the engine reported, the model list, or a safe default. */
export async function contextWindow(agent: ModelOf, chat?: Chat | null): Promise<number> {
  const set = getSettings().contextWindowTokens;
  if (set) return set;
  const reported = measurement(chat, agent)?.window;
  if (reported) return reported;
  const model = String(agent.model || '');
  if (agent.engine === 'claude-code') return /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
  if (agent.engine === 'codex') return 272_000;
  if (
    agent.engine === 'hermes' ||
    agent.engine === 'pi' ||
    agent.engine === 'omp' ||
    agent.engine === 'openclaw' ||
    agent.engine === 'opencode'
  )
    return 128_000;
  const provider = String(agent.provider || 'openrouter');
  const local = provider === 'lmstudio' || provider === 'ollama';
  const id = model || defaultModelForEngine('eve', getSettings().defaults, provider);
  const key = `${provider}|${PROVIDERS[provider as ProviderId]?.base() || ''}`;
  let w = windows.get(key);
  if (!w || Date.now() - w.at > 10 * 60_000) {
    const { listModels } = await import('./providers.ts');
    const list = await listModels(provider).catch(() => []);
    w = { at: Date.now(), models: new Map(list.filter((m) => m.context).map((m) => [m.id, m.context!])) };
    // (an empty answer is retried sooner: the server may just be starting)
    if (!list.length) w.at = Date.now() - 9 * 60_000;
    windows.set(key, w);
  }
  return w.models.get(id) || (local ? 32_000 : 128_000);
}

/** Where a turn was stopped partway, as the agent reads it in a rebuilt memory (so it carries on rather than starts over). */
export function stopMark(item: ChatItem): string {
  if (item.type !== 'error' || !item.stopped) return '';
  return item.stopped === 'steer'
    ? '(My turn was stopped here, before it finished, to take the next message. The steps above are done.)'
    : '(The user stopped my turn here, before it finished. The steps above are done.)';
}

// ---------- a fresh session's history ----------
/** How much of the window a fresh session's history may fill when all of it doesn't fit: the rest is room to work. */
export const SEED_SHARE = 0.6;

/** The newest part of a history that fits in budget tokens. When not all of it fits, the cut moves forward to where
 *  a message of the user's starts, so the part kept doesn't open halfway through a turn. left: how many were left out. */
export function newestThatFits<T>(
  items: readonly T[],
  size: (item: T) => number,
  budget: number,
  opensTurn: (item: T) => boolean,
): { kept: T[]; left: number } {
  let total = 0;
  let from = items.length;
  while (from > 0 && total + size(items[from - 1]) <= budget) total += size(items[--from]);
  if (from === 0) return { kept: [...items], left: 0 };
  let start = from;
  while (start < items.length && !opensTurn(items[start])) start++;
  // (no message of the user's in what fits: keep what fits)
  if (start === items.length) start = from;
  return { kept: items.slice(start), left: start };
}

/** What a fresh session is told when the oldest part of its chat was left out of its history. Nothing is lost: the
 *  chat keeps every original, and the agent reads them with its conversation tools. */
export const leftOutNote = (left: number): string =>
  `(The ${left} oldest message${left === 1 ? '' : 's'} of this chat ${left === 1 ? 'is' : 'are'} left out here: the whole conversation doesn't fit the model's context. Their original text is kept. Before guessing about earlier work, find it with search_conversations and read it with read_conversation.)`;

/** A fresh CLI session receives the retained originals after Clear memory, whole. When they don't all fit the model,
 *  it gets the newest part that does, and is told where the rest is. */
export function seedPrompt(items: ChatItem[], prompt: string, window: number, system = ''): string {
  const current = items.findLastIndex((item) => item.type === 'user');
  const entries = items
    .slice(memoryStart(items), current < 0 ? items.length : current)
    .flatMap((item): { text: string; asked: boolean }[] => {
      if (item.type === 'user' || item.type === 'steer')
        return [
          {
            text: `${item.from || 'User'}: ${item.text}${item.attachments?.length ? `\nAttachments: ${item.attachments.join(', ')}` : ''}`,
            asked: true,
          },
        ];
      if (item.type === 'assistant') return [{ text: `Assistant: ${item.text}`, asked: false }];
      if (item.type === 'tool')
        return [
          {
            text: `Tool ${item.name}\nInput: ${JSON.stringify(item.args || {})}\nResult: ${item.result ?? '(unfinished)'}`,
            asked: false,
          },
        ];
      if (stopMark(item)) return [{ text: `Assistant: ${stopMark(item)}`, asked: false }];
      return [];
    });
  const history = entries.map((entry) => entry.text).join('\n\n');
  const input = history
    ? `Earlier conversation (original messages):\n${history}\n\nCurrent request:\n${prompt}`
    : prompt;
  if (estimateTokens(system + input) <= window * 0.85) return input;
  // (a current request too big on its own is refused by the run: it is never shortened)
  const budget = Math.floor(window * SEED_SHARE) - estimateTokens(system + prompt);
  const { kept, left } = newestThatFits(
    entries,
    (entry) => estimateTokens(entry.text) + 2,
    budget,
    (entry) => entry.asked,
  );
  const text = [leftOutNote(left), ...kept.map((entry) => entry.text)].join('\n\n');
  return `Earlier conversation (original messages, the newest part):\n${text}\n\nCurrent request:\n${prompt}`;
}
