// Chat compaction: the instant compiler, which messages stay in full, and compacting during real runs
// (API model with a fake server; Claude Code with a fake CLI).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { chats, saveSettings } from '../../server/store.ts';
import { compactNow, editCompaction, startRun } from '../../server/engines/index.ts';
import { compactChat, compileHistory, cutTokens, estimateTokens, GUIDE, INSTANT, latestCompaction, memoryStart, planTail, rebuildLlm, recall, seedPrompt, sizesFor } from '../../server/compaction.ts';
import type { LlmMessage } from '../../server/engines/openai.ts';
import type { Chat, ChatItem, CompactionItem } from '../../shared/types.ts';

// ---------- a fake Claude Code: records what it was sent ----------
const cli = vi.hoisted(() => ({ prompts: [] as string[], sessions: [] as (string | null)[], compactOnce: false }));
vi.mock('../../server/engines/claude.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/engines/claude.ts')>()),
  run: async ({ chat, text, onEvent }: { chat: Chat; text: string; onEvent: (e: unknown) => void }) => {
    cli.prompts.push(text);
    cli.sessions.push(chat.sessionId);
    if (cli.compactOnce) {
      cli.compactOnce = false;
      onEvent({ kind: 'compacted', trigger: 'auto', tokensBefore: 150_000 });
    }
    chat.sessionId = `session-${cli.prompts.length}`;
    onEvent({ kind: 'text', text: 'done' });
    return { text: 'done', context: 1000 };
  },
}));

// ---------- a fake API model ----------
let server: http.Server;
const requests: { messages: { role: string; content: string | null }[] }[] = [];
let failNext = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      requests.push(JSON.parse(body));
      if (failNext) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: failNext } }));
        failNext = '';
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' } } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  saveSettings({ compaction: { auto: true, instant: true, thresholdPercent: 50, keepMessages: 4, windowTokens: 0 } });
  requests.length = 0;
  cli.prompts.length = 0;
  cli.sessions.length = 0;
});

const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
/** n finished turns: a question, a tool call with a big result, an answer. */
function history(n: number, size = 400): ChatItem[] {
  const items: ChatItem[] = [];
  for (let t = 0; t < n; t++) {
    items.push({ type: 'user', text: `question ${t}: ${words(size, 'q')}` });
    items.push({ type: 'tool', id: `call${t}`, name: 'read_file', args: { path: `src/file${t}.ts` }, result: `RESULT-${t} ${words(size * 2, 'r')}`, status: 'done' });
    items.push({ type: 'assistant', text: `answer ${t}: ${words(size, 'a')}` });
  }
  return items;
}
function llmOf(n: number, size = 400): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (let t = 0; t < n; t++) {
    out.push({ role: 'user', content: `question ${t}: ${words(size, 'q')}` });
    out.push({ role: 'assistant', content: null, tool_calls: [{ id: `call${t}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    out.push({ role: 'tool', tool_call_id: `call${t}`, content: `RESULT-${t} ${words(size * 2, 'r')}` });
    out.push({ role: 'assistant', content: `answer ${t}: ${words(size, 'a')}` });
  }
  return out;
}

describe('token estimate and cutting', () => {
  it('counts words, CJK and emoji, and cuts between characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(4); // two 5-letter words: 2 each
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('😀')).toBe(2);
    const c = cutTokens('😀😀😀😀', 3);
    expect(c.cut).toBe(true);
    expect(c.text).toBe('😀');
    expect(cutTokens('short', 10)).toEqual({ text: 'short', cut: false });
  });

  it('a base64 blob can not pass as one word: it is cut at budget × 4 characters', () => {
    const blob = 'A'.repeat(10_000);
    expect(cutTokens(blob, 100).text.length).toBeLessThanOrEqual(400);
  });
});

describe('the instant compiler', () => {
  it('keeps the words, leaves tool results out and keeps every seq', () => {
    const items = history(2, 50);
    const { body } = compileHistory(items, items.map((_, i) => i), null, INSTANT);
    expect(body).toContain('[seq 0] user: question 0');
    expect(body).toContain('[seq 1] tool read_file path="src/file0.ts" → ok');
    expect(body).not.toContain('RESULT-0');
    expect(body).toContain('[seq 2] you: answer 0');
  });

  it('cuts long messages and says where the full text is', () => {
    const items: ChatItem[] = [{ type: 'assistant', text: words(5000) }];
    const { body } = compileHistory(items, [0], null, INSTANT);
    expect(body).toMatch(/…\(cut; full text: seq 0\)$/);
    expect(estimateTokens(body)).toBeLessThan(700);
  });

  it('over the cap: shrinks messages, then leaves out the oldest tool calls, then the oldest entries; the newest stays', () => {
    const items = history(40, 60);
    const all = items.map((_, i) => i);
    const tight = compileHistory(items, all, null, { ...INSTANT, cap: 2500 });
    expect(tight.tokens).toBeLessThanOrEqual(2500 + 50);
    expect(tight.body).toContain('[seq 119] you: answer 39');
    // tool lines went before the text did
    expect(tight.body).toMatch(/tool calls? left out to save room/);
    const tighter = compileHistory(items, all, null, { ...INSTANT, cap: 300 });
    expect(tighter.body).toMatch(/earlier entr(y|ies) left out/);
    expect(tighter.body).toContain('[seq 119]');
  });

  it('copies the compacted history before it, without its guide', () => {
    const items = history(1, 10);
    const { body } = compileHistory(items, [0], { seq: 7, text: `${GUIDE}\n\nOLD HISTORY` }, INSTANT);
    expect(body).toContain('[seq 7] the compacted history before this one:\nOLD HISTORY');
    expect(body).not.toContain(GUIDE);
  });
});

describe('which messages stay in full', () => {
  it('keeps the last N messages with their tool calls, the message being answered counting as one', () => {
    const items = [...history(5, 20), { type: 'user', text: 'new' } as ChatItem];
    // 4 messages: new (15), answer 4 (14), question 4 (12), answer 3 (11)
    expect(planTail(items, 0, { keepMessages: 4, maxTokens: 1e9, current: true })).toBe(11);
    expect(planTail(items, 0, { keepMessages: 1, maxTokens: 1e9, current: true })).toBe(15);
    expect(planTail(items, 0, { keepMessages: 0, maxTokens: 1e9, current: true })).toBe(15);
    // no message being answered (the Compact button): the last 2 messages
    expect(planTail(history(5, 20), 0, { keepMessages: 2, maxTokens: 1e9, current: false })).toBe(12);
  });

  it('drops the oldest kept messages when they would not fit', () => {
    const items = [...history(5, 400), { type: 'user', text: 'new' } as ChatItem];
    expect(planTail(items, 0, { keepMessages: 10, maxTokens: 100, current: true })).toBe(15);
    expect(planTail(items, 0, { keepMessages: 10, maxTokens: 500, current: true })).toBe(14);
  });

  it('grows with the context window: a 1M model keeps far more than a 200k one', () => {
    const big = sizesFor(1_000_000);
    const std = sizesFor(200_000);
    expect(big.compile.cap).toBe(150_000);
    expect(std.compile.cap).toBe(30_000);
    expect(big.tail).toBe(250_000);
    expect(big.compile.textTokens).toBe(5 * std.compile.textTokens);
    // a small local model still fits: checkpoint + tail stay under the threshold
    const small = sizesFor(8_000);
    expect(small.compile.cap + small.tail).toBeLessThan(8_000 * 0.5);
  });
});

describe('compactChat()', () => {
  const chatWith = (items: ChatItem[], llm: LlmMessage[] = []): Chat => ({ id: 'c1', agentId: 'a', title: 't', items, llm, sessionId: 'old-session', createdAt: 0, updatedAt: 0 });

  it('marks the spot before the message being answered, and starts the next session from it', async () => {
    const chat = chatWith([...history(6), { type: 'user', text: 'new question' }]);
    const item = (await compactChat(chat, { trigger: 'auto', window: 200_000, current: true, keepMessages: 3 }))!;
    expect(item).toBeTruthy();
    const at = chat.items.indexOf(item);
    expect(at).toBe(18);
    expect(chat.items[19]).toMatchObject({ type: 'user', text: 'new question' });
    // 3 messages stay: question 5 (15), answer 5 (17), the new one
    expect(item.upto).toBe(15);
    expect(memoryStart(chat.items)).toBe(15);
    expect(item.text.startsWith(GUIDE)).toBe(true);
    expect(item.text).toContain('[seq 14] you: answer 4');
    expect(item.text).not.toContain('[seq 15]');
    expect(item.tokensAfter!).toBeLessThan(item.tokensBefore!);
    expect(chat.sessionId).toBeNull();
    expect(chat.reseed).toBe(true);
  });

  it('does nothing when there is nothing to compact', async () => {
    const chat = chatWith([{ type: 'user', text: 'hi' }]);
    expect(await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 10 })).toBeNull();
    expect(chat.items).toHaveLength(1);
    expect(chat.sessionId).toBe('old-session');
  });

  it('a second compaction builds on the first, and Clear memory starts over', async () => {
    const chat = chatWith(history(6));
    const first = (await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 2 }))!;
    chat.items.push(...history(4));
    const second = (await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 2 }))!;
    expect(second.text).toContain(`[seq ${chat.items.indexOf(first)}] the compacted history before this one`);
    expect(latestCompaction(chat.items)?.item.id).toBe(second.id);
    chat.items.push({ type: 'meta', text: 'Memory cleared: the agent starts fresh from here.', reset: true });
    expect(latestCompaction(chat.items)).toBeNull();
    expect(memoryStart(chat.items)).toBe(chat.items.length);
  });

  it("keeps the API model's messages for the turns that stay", async () => {
    const chat = chatWith(history(4), llmOf(4));
    const item = (await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 2 }))!;
    expect(item.upto).toBe(9); // question 3
    const llm = chat.llm as LlmMessage[];
    expect(llm[0]).toMatchObject({ role: 'user', content: expect.stringContaining('question 3') });
    expect(llm).toHaveLength(4);
  });
});

describe('rebuildLlm()', () => {
  it('a tail that starts inside a turn keeps that turn’s user message in front', () => {
    const items = history(3, 5);
    // tail from "answer 1" (seq 5)
    const llm = rebuildLlm(llmOf(3, 5), items, 5);
    expect(llm[0]).toMatchObject({ role: 'user', content: expect.stringContaining('question 1') });
    expect(llm[1]).toMatchObject({ role: 'assistant', content: expect.stringContaining('answer 1') });
    expect(llm.filter((m) => m.role === 'user')).toHaveLength(2);
    // tail from a tool call (seq 4): its assistant message and result stay together
    const fromTool = rebuildLlm(llmOf(3, 5), items, 4);
    expect(fromTool[1]).toMatchObject({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call1' })] });
    expect(fromTool[2]).toMatchObject({ role: 'tool', tool_call_id: 'call1' });
  });
});

describe('seedPrompt() and recall()', () => {
  it('a new session gets the compacted history, the kept messages in full, then the new message', async () => {
    const chat: Chat = { id: 'c', agentId: 'a', title: 't', items: history(5), llm: [], sessionId: null, createdAt: 0, updatedAt: 0 };
    await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 2 });
    chat.items.push({ type: 'user', text: 'next' });
    const p = seedPrompt(chat.items, 'next');
    expect(p).toContain('<compacted-history>');
    expect(p).toContain(GUIDE);
    // the kept messages, word for word
    expect(p).toContain(`answer 4: ${words(400, 'a')}`);
    expect(p.endsWith('next')).toBe(true);
  });

  it('a kept tool call goes to the new session with its whole input, not just its key argument', async () => {
    const content = `export function parse() {\n  ${words(200, 'tok')}\n}`;
    const chat: Chat = { id: 'c', agentId: 'a', title: 't', items: [...history(5), { type: 'user', text: 'write it' }, { type: 'tool', id: 'w1', name: 'Write', args: { file_path: '/src/parse.ts', content }, result: 'File written', status: 'done' }, { type: 'assistant', text: 'Written.' }], llm: [], sessionId: null, createdAt: 0, updatedAt: 0 };
    await compactChat(chat, { trigger: 'manual', window: 200_000, current: false, keepMessages: 2 });
    chat.items.push({ type: 'user', text: 'next' });
    const p = seedPrompt(chat.items, 'next');
    expect(p).toContain('"file_path": "/src/parse.ts"');
    expect(p).toContain(JSON.stringify(content));
    expect(p).toContain('result: File written');
  });

  it('reads entries back in full, by seq, range or search', () => {
    const items = history(3, 5);
    expect(recall(items, { seq: 1 }).text).toContain('RESULT-0');
    expect(recall(items, { seq: 99 }).isError).toBe(true);
    const range = recall(items, { from: 3, to: 5 }).text;
    expect(range).toContain('[seq 3]');
    expect(range).toContain('[seq 5]');
    expect(range).not.toContain('[seq 6]');
    expect(recall(items, { query: 'RESULT-2' }).text).toContain('[seq 7]');
    expect(recall(items, {}).text).toContain('9 entries');
  });
});

describe('during runs', () => {
  it('Claude Code: compacts before the run when full, and the new session gets the compacted history', async () => {
    saveSettings({ compaction: { windowTokens: 20_000, keepMessages: 2 } });
    const a = newAgent({ name: 'Coder', engine: 'claude-code', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push(...history(8));
    chat.sessionId = 'long-session';
    chats.save(chat);
    const run = startRun(a, chat, 'carry on');
    await run.promise;
    const saved = chats.get(a.id, chat.id)!;
    const item = saved.items.find((i): i is CompactionItem => i.type === 'compaction')!;
    expect(item).toMatchObject({ mode: 'instant', trigger: 'auto' });
    expect(saved.items[saved.items.indexOf(item) + 1]).toMatchObject({ type: 'user', text: 'carry on' });
    expect(cli.sessions[0]).toBeNull();
    expect(cli.prompts[0]).toContain('<compacted-history>');
    expect(cli.prompts[0].endsWith('carry on')).toBe(true);
    // the session has it now: the next message goes as it is, in that session
    expect(saved.reseed).toBeUndefined();
    await startRun(a, saved, 'and then?').promise;
    expect(cli.prompts[1]).toBe('and then?');
    expect(cli.sessions[1]).toBe('session-1');
  });

  it("Claude Code's own compaction is marked, but changes nothing else", async () => {
    const a = newAgent({ name: 'Coder 2', engine: 'claude-code', toolGroups: [] });
    const chat = chats.create(a.id);
    cli.compactOnce = true;
    await startRun(a, chat, 'hi').promise;
    const saved = chats.get(a.id, chat.id)!;
    expect(saved.items.find((i) => i.type === 'compaction')).toMatchObject({ mode: 'engine', tokensBefore: 150_000 });
    expect(latestCompaction(saved.items)).toBeNull();
    expect(saved.sessionId).toBe('session-1');
  });

  it('API model: compacts before asking when the memory is full, and sends the compacted history with the instructions', async () => {
    saveSettings({ compaction: { windowTokens: 20_000, keepMessages: 2 } });
    const a = newAgent({ name: 'Api', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push(...history(8));
    chat.llm = llmOf(8);
    chats.save(chat);
    await startRun(a, chat, 'carry on').promise;
    expect(requests).toHaveLength(1);
    const msgs = requests[0].messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('<compacted-history>');
    // only the kept messages: answer 7 and the new one (the turn's question goes in front of the answer)
    expect(msgs.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs.at(-1)!.content).toBe('carry on');
    const saved = chats.get(a.id, chat.id)!;
    expect(saved.items.filter((i) => i.type === 'compaction')).toHaveLength(1);
    expect(saved.items.at(-1)).toMatchObject({ type: 'assistant', text: 'answer' });
  });

  it('API model: when the model says it is too long, compacts once and asks again', async () => {
    saveSettings({ compaction: { windowTokens: 1_000_000, keepMessages: 2 } });
    const a = newAgent({ name: 'Api 2', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push(...history(3));
    chat.llm = llmOf(3);
    chats.save(chat);
    failNext = "This model's maximum context length is 8192 tokens.";
    await startRun(a, chat, 'go').promise;
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content).toContain('<compacted-history>');
    const saved = chats.get(a.id, chat.id)!;
    expect(saved.items.find((i) => i.type === 'compaction')).toMatchObject({ trigger: 'overflow' });
    expect(saved.items.some((i) => i.type === 'error')).toBe(false);
  });

  it('no automatic compaction when it is switched off', async () => {
    saveSettings({ compaction: { auto: false, windowTokens: 20_000 } });
    const a = newAgent({ name: 'Api 3', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push(...history(8));
    chat.llm = llmOf(8);
    chats.save(chat);
    await startRun(a, chat, 'go').promise;
    expect(chats.get(a.id, chat.id)!.items.some((i) => i.type === 'compaction')).toBe(false);
  });
});

describe('compacting by hand and editing', () => {
  it('the Compact button compacts; only the latest compaction can be edited, and an edit restarts the session from it', async () => {
    const a = newAgent({ name: 'Editor', engine: 'claude-code', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push(...history(6));
    chats.save(chat);
    const first = (await compactNow(a, chat.id)).item!;
    expect(first).toMatchObject({ trigger: 'manual', mode: 'instant' });
    const mid = chats.get(a.id, chat.id)!;
    mid.items.push(...history(6));
    mid.sessionId = 'live';
    delete mid.reseed;
    chats.save(mid);
    const second = (await compactNow(a, chat.id)).item!;
    expect(() => editCompaction(a.id, chat.id, first.id, 'x')).toThrow(/Only the latest/);
    expect(() => editCompaction(a.id, chat.id, second.id, '  ')).toThrow(/cannot be empty/);
    const edited = editCompaction(a.id, chat.id, second.id, 'MY OWN NOTES');
    expect(edited.items.find((i) => i.type === 'compaction' && i.id === second.id)).toMatchObject({ text: 'MY OWN NOTES', editedAt: expect.any(Number) });
    expect(edited.reseed).toBe(true);
    await startRun(a, edited, 'go on').promise;
    expect(cli.prompts.at(-1)).toContain('MY OWN NOTES');
  });

  it('says so when there is nothing to compact', async () => {
    const a = newAgent({ name: 'Short', engine: 'claude-code', toolGroups: [] });
    const chat = chats.create(a.id);
    chat.items.push({ type: 'user', text: 'hi' }, { type: 'assistant', text: 'hello' });
    chats.save(chat);
    expect((await compactNow(a, chat.id)).item).toBeNull();
  });
});
