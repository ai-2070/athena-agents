// A saved chat as OpenUI messages, and live events applied to a chat.
import { describe, expect, it } from 'vitest';
import { readToolContent, readUserContent, seqOf, toMessages, toolContent, userContent } from '../../web/chat/convert.ts';
import { applyRunEvent } from '../../web/chat/live.ts';
import type { ChatItem } from '../../shared/types.ts';

describe('toMessages()', () => {
  it('a turn: the message, the answer with its tool calls, then their results', () => {
    const items: ChatItem[] = [
      { type: 'user', text: 'render it', attachments: ['/w/brief.pdf'] },
      { type: 'assistant', text: 'On it.' },
      { type: 'tool', id: 't1', name: 'blender_run_python', args: { code: 'x' }, result: 'ok', images: ['/api/file?path=a.png'], status: 'done' },
      { type: 'tool', id: 't2', name: 'ffmpeg', args: { args: ['-i'] }, result: 'bad', isError: true, status: 'error' },
      { type: 'assistant', text: 'Done: /w/out.png' },
    ];
    const m = toMessages(items);
    expect(m.map((x) => [x.id, x.role])).toEqual([
      ['m-0', 'user'],
      ['m-1', 'assistant'],
      ['m-2-result', 'tool'],
      ['m-3-result', 'tool'],
      ['m-4', 'assistant'],
    ]);
    const answer = m[1] as Extract<(typeof m)[number], { role: 'assistant' }>;
    expect(answer.toolCalls?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(JSON.parse(answer.toolCalls![0].function.arguments)).toEqual({ code: 'x' });
    expect(m[2]).toMatchObject({ toolCallId: 't1' });
    expect(readToolContent((m[2] as { content: string }).content)).toEqual({ text: 'ok', images: ['/api/file?path=a.png'] });
    expect(m[3]).toMatchObject({ toolCallId: 't2', error: 'bad' });
    expect(readUserContent(m[0] as never)).toEqual({ text: 'render it', attachments: ['/w/brief.pdf'] });
  });

  it('tool calls with no text before them get an answer of their own; a running one has no result yet', () => {
    const m = toMessages([
      { type: 'user', text: 'go' },
      { type: 'tool', id: 'a', name: 'read_file', args: {}, result: null, status: 'running' },
    ]);
    expect(m.map((x) => x.id)).toEqual(['m-0', 'm-1-calls']);
    expect(m[1]).toMatchObject({ role: 'assistant', content: '', toolCalls: [expect.objectContaining({ id: 'a' })] });
  });

  it('tool calls never join an answer from before the user spoke again', () => {
    const m = toMessages([
      { type: 'assistant', text: 'hi' },
      { type: 'user', text: 'next' },
      { type: 'tool', id: 'b', name: 'x', args: {}, result: 'r', status: 'done' },
    ]);
    expect(m.map((x) => x.id)).toEqual(['m-0', 'm-1', 'm-2-calls', 'm-2-result']);
  });

  it('errors, notes and COMPACTED marks become activity messages (with the item)', () => {
    const m = toMessages([
      { type: 'error', text: 'Stopped.' },
      { type: 'meta', text: '$0.01' },
      { type: 'compaction', id: 'k1', text: 'history', mode: 'instant', trigger: 'auto', upto: 0 },
    ]);
    expect(m.map((x) => [x.role, (x as { activityType?: string }).activityType])).toEqual([
      ['activity', 'error'],
      ['activity', 'meta'],
      ['activity', 'compaction'],
    ]);
    expect((m[2] as unknown as { content: { id: string } }).content.id).toBe('k1');
  });

  it('a message from another agent keeps who sent it', () => {
    expect(toMessages([{ type: 'user', text: 'do x', from: 'Planner' }])[0]).toMatchObject({ name: 'Planner' });
  });
});

describe('the small helpers', () => {
  it('seqOf() finds the item a message came from', () => {
    expect(seqOf('m-12')).toBe(12);
    expect(seqOf('m-3-calls')).toBe(3);
    expect(seqOf('live-r1')).toBeNull();
  });

  it('user and tool contents read back what was written', () => {
    expect(userContent('hi')).toBe('hi');
    expect(readUserContent({ content: userContent('see', ['C:\\a\\b.png']) })).toEqual({ text: 'see', attachments: ['C:\\a\\b.png'] });
    expect(readToolContent(toolContent('out', ['/x.png']))).toEqual({ text: 'out', images: ['/x.png'] });
    // (a result that isn't ours is its own text)
    expect(readToolContent('plain')).toEqual({ text: 'plain', images: [] });
  });
});

describe('applyRunEvent()', () => {
  it('builds a turn from live events, without changing the old list', () => {
    const start: ChatItem[] = [];
    let items = applyRunEvent(start, { kind: 'start', text: 'hello', from: 'team Ops' });
    items = applyRunEvent(items, { kind: 'text', text: 'Work' });
    items = applyRunEvent(items, { kind: 'text', text: 'ing' });
    items = applyRunEvent(items, { kind: 'tool', id: 't', name: 'read_file', args: { path: 'a' } });
    items = applyRunEvent(items, { kind: 'tool_result', id: 't', text: 'contents', images: ['/i.png'] });
    items = applyRunEvent(items, { kind: 'text', text: 'Done.' });
    expect(start).toEqual([]);
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(items[1]).toMatchObject({ text: 'Working' });
    expect(items[2]).toMatchObject({ status: 'done', result: 'contents', images: ['/i.png'] });
  });

  it('a start for a message already there adds nothing; a failed tool is marked', () => {
    let items: ChatItem[] = [{ type: 'user', text: 'hello' }];
    items = applyRunEvent(items, { kind: 'start', text: 'hello' });
    expect(items).toHaveLength(1);
    items = applyRunEvent(items, { kind: 'tool', id: 'x', name: 'ffmpeg' });
    items = applyRunEvent(items, { kind: 'tool_result', id: 'x', text: 'boom', isError: true });
    expect(items[1]).toMatchObject({ status: 'error', isError: true });
  });
});
