// Brain messages wait their turn, and belong to the project and conversation they were typed in.
import { describe, expect, it } from 'vitest';
import { brainQueue, holdQueue, latestLoad } from '../../web/brainqueue.ts';

// a fake server: each request waits until the test answers it
function fakeServer() {
  const calls: { text: string; project: string | null; answer: (v: string) => void; fail: (e: Error) => void }[] = [];
  const post = (text: string, project: string | null) =>
    new Promise<string>((answer, fail) => {
      calls.push({ text, project, answer, fail });
    });
  return { calls, post };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('brainQueue()', () => {
  it('sends one message at a time, with the project it was typed in', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    const first = q.ask('one', 'A', () => 'A');
    const second = q.ask('two', 'A', () => 'A');
    await tick();
    expect(s.calls.map((c) => c.text)).toEqual(['one']);
    s.calls[0].answer('first answer');
    expect(await first).toEqual({ kind: 'answer', answer: 'first answer' });
    await tick();
    expect(s.calls.map((c) => [c.text, c.project])).toEqual([['one', 'A'], ['two', 'A']]);
    s.calls[1].answer('second answer');
    expect(await second).toEqual({ kind: 'answer', answer: 'second answer' });
  });

  it('never sends a waiting message after you switched projects', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    let open = 'A';
    const first = q.ask('one', 'A', () => open);
    const second = q.ask('two', 'A', () => open);
    await tick();
    open = 'B';
    s.calls[0].answer('late');
    expect(await first).toEqual({ kind: 'stale' });
    expect(await second).toEqual({ kind: 'stale' });
    expect(s.calls.map((c) => c.text)).toEqual(['one']);
  });

  it('drops answers that arrive after a new conversation started, and never sends what waited', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    const pending = q.ask('one', 'A', () => 'A');
    const waiting = q.ask('two', 'A', () => 'A');
    await tick();
    q.reset();
    s.calls[0].answer('old answer');
    expect(await pending).toEqual({ kind: 'stale' });
    expect(await waiting).toEqual({ kind: 'stale' });
    expect(s.calls.map((c) => c.text)).toEqual(['one']);
    // new messages go through as usual
    const fresh = q.ask('three', 'A', () => 'A');
    await tick();
    s.calls.at(-1)!.answer('new answer');
    expect(await fresh).toEqual({ kind: 'answer', answer: 'new answer' });
  });

  it('drops an error from a request that was already sent when the conversation was cleared', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    const inFlight = q.ask('one', 'A', () => 'A');
    await tick();
    expect(s.calls).toHaveLength(1); // sent, waiting for the server
    q.reset();
    s.calls[0].fail(new Error('late failure'));
    expect(await inFlight).toEqual({ kind: 'stale' });
  });

  it('a message typed before the project was known is not sent once one opens', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    let open: string | null = 'A';
    const first = q.ask('one', 'A', () => open);
    const early = q.ask('typed while loading', null, () => open);
    await tick();
    s.calls[0].answer('fine');
    expect(await first).toEqual({ kind: 'answer', answer: 'fine' });
    expect(await early).toEqual({ kind: 'stale' });
    expect(s.calls.map((c) => c.text)).toEqual(['one']);
    open = null;
    const unknown = q.ask('still loading', null, () => open);
    await tick();
    open = 'B'; // the project became known while it was being answered
    s.calls.at(-1)!.answer('for nobody');
    expect(await unknown).toEqual({ kind: 'stale' });
  });

  it('reports a failed request as an error', async () => {
    const s = fakeServer();
    const q = brainQueue(s.post);
    const r = q.ask('one', 'A', () => 'A');
    await tick();
    s.calls[0].fail(new Error('You switched projects'));
    expect(await r).toEqual({ kind: 'error', error: 'You switched projects' });
  });
});

describe('latestLoad()', () => {
  it('only the newest load may fill the view, and reset() drops them all', () => {
    const loads = latestLoad();
    const first = loads.start();
    const second = loads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    loads.reset();
    expect(second()).toBe(false);
    expect(loads.start()()).toBe(true);
  });
});

describe('holdQueue() (/queue in the Brain chat)', () => {
  // a chat that is busy until the test says so; each send stays on its way until the test finishes it
  function chat() {
    let busy = true;
    const sent: { text: string; done: () => void }[] = [];
    let changes = 0;
    const q = holdQueue<string>({
      idle: () => !busy,
      send: (m) => new Promise<void>((done) => sent.push({ text: `${m.text}→${m.extra}`, done })),
      onChange: () => changes++,
    });
    return { q, sent, setBusy: (b: boolean) => (busy = b), changes: () => changes };
  }

  it('holds messages while the chat works, then sends them one at a time, in order', async () => {
    const c = chat();
    c.q.add('one', 'brain');
    c.q.add('two', 'agent');
    c.q.check();
    expect(c.sent).toEqual([]);
    expect(c.q.items().map((m) => m.text)).toEqual(['one', 'two']);
    c.setBusy(false);
    c.q.check();
    c.q.check();
    expect(c.sent.map((s) => s.text)).toEqual(['one→brain']);
    expect(c.q.items().map((m) => m.text)).toEqual(['two']);
    // the first one keeps the chat busy after it went (the Brain is answering it)
    c.setBusy(true);
    c.sent[0].done();
    await tick();
    expect(c.sent).toHaveLength(1);
    c.setBusy(false);
    c.q.check();
    expect(c.sent.map((s) => s.text)).toEqual(['one→brain', 'two→agent']);
    expect(c.q.items()).toEqual([]);
  });

  it('sends straight away when nothing is working', () => {
    const c = chat();
    c.setBusy(false);
    c.q.add('now', 'brain');
    expect(c.sent.map((s) => s.text)).toEqual(['now→brain']);
  });

  it('takes one back, or all of them (a new conversation)', () => {
    const c = chat();
    const one = c.q.add('one', 'x');
    c.q.add('two', 'x');
    c.q.add('three', 'x');
    c.q.remove(one.id);
    expect(c.q.items().map((m) => m.text)).toEqual(['two', 'three']);
    expect(c.q.clear().map((m) => m.text)).toEqual(['two', 'three']);
    c.setBusy(false);
    c.q.check();
    expect(c.sent).toEqual([]);
    expect(c.changes()).toBeGreaterThan(0);
  });

  it('keeps going after a send fails', async () => {
    let busy = true;
    const sent: string[] = [];
    const q = holdQueue<null>({
      idle: () => !busy,
      send: (m) => (sent.push(m.text), m.text === 'bad' ? Promise.reject(new Error('no')) : Promise.resolve()),
      onChange: () => {},
    });
    q.add('bad', null);
    q.add('good', null);
    busy = false;
    q.check();
    await tick();
    await tick();
    expect(sent).toEqual(['bad', 'good']);
  });
});
