// An agent's run, or the Brain's answer, as Vercel AI SDK UI message chunks, for the chat views (useChat and the
// AI SDK's stream reader): the answer's text as it is written, each tool call with its input and then its
// result, and status lines as transient data parts. A view that opens while a run is going gets the turn so far
// first (a replay from its start), then the rest live. The oRPC routes send them as events (server/api/agents.ts,
// brain.ts), with oRPC's own keep-alive.
import type { UIMessageChunk } from 'ai';
import { bus } from './store.ts';
import type { ChatItem, RunEvent, ServerEvent } from '../shared/types.ts';

/** What a tool's result is in the stream (the output of its dynamic-tool part). */
export interface ToolOutput {
  text: string;
  images: string[];
}

/** Turns one turn (live events, or saved items) into UI message chunks. */
export class TurnChunks {
  private textId: string | null = null;
  private n = 0;
  private open = false;
  private readonly emit: (chunk: UIMessageChunk) => void;
  constructor(emit: (chunk: UIMessageChunk) => void) {
    this.emit = emit;
  }

  start(messageId: string): void {
    this.open = true;
    this.emit({ type: 'start', messageId });
    this.emit({ type: 'start-step' });
  }
  text(delta: string): void {
    if (!delta) return;
    if (!this.textId) {
      this.textId = `t${++this.n}`;
      this.emit({ type: 'text-start', id: this.textId });
    }
    this.emit({ type: 'text-delta', id: this.textId, delta });
  }
  /** A data part (data-<name>); transient ones are seen as they come but not kept in the message. */
  data(name: string, data: unknown, transient = false): void {
    this.endText();
    this.emit({ type: `data-${name}`, data, ...(transient ? { transient: true } : {}) } as UIMessageChunk);
  }
  endText(): void {
    if (!this.textId) return;
    this.emit({ type: 'text-end', id: this.textId });
    this.textId = null;
  }
  tool(id: string, name: string, args: unknown): void {
    this.endText();
    this.emit({ type: 'tool-input-available', toolCallId: id, toolName: name, input: args ?? {}, dynamic: true });
  }
  result(id: string, text: string | null | undefined, images: readonly string[] = [], isError = false): void {
    if (isError) this.emit({ type: 'tool-output-error', toolCallId: id, errorText: String(text || 'Failed'), dynamic: true });
    else this.emit({ type: 'tool-output-available', toolCallId: id, output: { text: String(text ?? ''), images: [...images] } satisfies ToolOutput, dynamic: true });
  }
  status(text: string): void {
    this.emit({ type: 'data-status', data: { text }, transient: true } as UIMessageChunk);
  }
  /** One live event of the run. */
  event(e: RunEvent): void {
    if (e.kind === 'text') this.text(e.text);
    else if (e.kind === 'tool') this.tool(e.id, e.name, e.args);
    else if (e.kind === 'tool_result') this.result(e.id, e.text, e.images, e.isError);
    else if (e.kind === 'status') this.status(e.text);
    // a message that joined the turn: shown where it came in
    else if (e.kind === 'steer') this.data('steer', { steerId: e.id, text: e.text, ...(e.from ? { from: e.from } : {}), ...(e.attachments?.length ? { attachments: e.attachments } : {}) });
  }
  /** The turn so far, from the saved items (everything after the last message to the agent). */
  replay(items: readonly ChatItem[]): void {
    const from = items.findLastIndex((i) => i.type === 'user') + 1;
    for (const it of items.slice(from)) {
      if (it.type === 'assistant') this.text(it.text);
      else if (it.type === 'steer') this.data('steer', { steerId: it.steerId, text: it.text, ...(it.from ? { from: it.from } : {}), ...(it.attachments?.length ? { attachments: it.attachments } : {}) });
      else if (it.type === 'tool') {
        this.tool(it.id, it.name, it.args);
        if (it.result != null && it.status !== 'running') this.result(it.id, it.result, it.images, it.isError);
      }
    }
  }
  finish(): void {
    if (!this.open) return;
    this.open = false;
    this.endText();
    this.emit({ type: 'finish-step' });
    this.emit({ type: 'finish' });
  }
}

export interface StreamRunOptions {
  chatId: string;
  /** Only this run's events. Or the run once it starts (a message waiting for the run before it to end);
   *  null: it never will, and the stream just ends. */
  runId: string | Promise<string | null>;
  /** What it says while that run hasn't started yet. */
  waiting?: string;
  /** The turn so far, shown first (a view opening while it runs). */
  items?: readonly ChatItem[];
  /** the message this stream's request sent into the turn going on: the view shows it already */
  ownSteer?: string;
  /** whether the run is still going: one that ended before the stream began ends it at once */
  live?: (runId: string) => boolean;
}

// a run you stopped (or stopped for your new message) didn't fail
const STOPPED = new Set(['Stopped.', 'Stopped to take your new message.']);

/** The run as UI message chunks, until it ends. Listening starts at once (call it in the same moment the run
 *  starts or is read); a reader that goes away (cancels) stops it listening, not the run. */
export function streamRun({ chatId, runId, items = [], waiting = 'Waiting…', ownSteer, live }: StreamRunOptions): ReadableStream<UIMessageChunk> {
  let over = false;
  let stop = () => {};
  return new ReadableStream<UIMessageChunk>({
    start(out) {
      const w = new TurnChunks((chunk) => !over && out.enqueue(chunk));
      const end = (close = true) => {
        if (over) return;
        if (close) w.finish();
        over = true;
        bus.off('event', listen);
        if (close) out.close();
      };
      stop = () => end(false);
      // (not known yet while it waits: nothing is ours until it is)
      let id = typeof runId === 'string' ? runId : null;
      const listen = (ev: ServerEvent) => {
        if (ev.type !== 'run' || ev.chatId !== chatId || id == null || ev.runId !== id) return;
        const e = ev.event as RunEvent;
        if (e.kind === 'steer' && e.id === ownSteer) return;
        // a run that failed ends the stream with the AI SDK's error (useChat's onError); "Stopped." is you
        if (e.kind === 'error' && e.text && !STOPPED.has(e.text)) out.enqueue({ type: 'error', errorText: e.text });
        if (e.kind === 'done' || e.kind === 'error') end();
        else w.event(e);
      };
      // (the replay and the listening start in the same moment, so nothing is missed or seen twice)
      w.start(`run-${id ?? `next-${Date.now()}`}`);
      w.replay(items);
      bus.on('event', listen);
      // (it ended before anyone listened: its done event went already)
      if (id != null && live && !live(id)) return end();
      if (typeof runId !== 'string') {
        w.status(waiting);
        // (its first events come later: a run streams only once its engine answers)
        void runId.then(
          (started) => (started ? void (id = started) : end()),
          () => end(),
        );
      }
    },
    cancel: () => stop(),
  });
}

// ---------- the Brain's answer ----------
/** What the Brain does while it answers (server/overseer.ts BrainPart). */
export type BrainStreamPart = { kind: 'text'; text: string } | { kind: 'tool'; id: string; name: string; args?: unknown } | { kind: 'tool_result'; id: string; text: string; isError?: boolean } | { kind: 'restart' };

/** The part of the Brain's answer to read: everything before its actions block (```actions), and
 *  never the start of that fence while it is still being written. */
export function readable(text: string, final = false): string {
  // (any case, as parseActions reads it)
  const at = text.search(/```actions/i);
  let out = at === -1 ? text : text.slice(0, at);
  if (final) return out;
  const tail = /`{1,3}(?:a(?:c(?:t(?:i(?:o(?:n(?:s)?)?)?)?)?)?)?$/i.exec(out);
  if (tail) out = out.slice(0, tail.index);
  return out;
}

/** The Brain's answer as UI message chunks: its text as it is written (without the actions), the files it
 *  reads, and at the end the whole answer (data-answer: what it did, whom it handed the work to). It goes on
 *  answering if the reader goes away. */
export function streamBrain(answer: (onPart: (p: BrainStreamPart) => void) => Promise<unknown>): ReadableStream<UIMessageChunk> {
  let gone = false;
  return new ReadableStream<UIMessageChunk>({
    start(out) {
      const write = (chunk: UIMessageChunk) => !gone && out.enqueue(chunk);
      const w = new TurnChunks(write);
      w.start(`brain-${Date.now()}`);
      let full = '';
      let shown = '';
      // (asked now, in the request's project; the chunks are read as they come)
      void (async () => {
        try {
          const a = await answer((p) => {
            if (p.kind === 'text') {
              full += p.text;
              const now = readable(full);
              if (now.length > shown.length && now.startsWith(shown)) w.text(now.slice(shown.length));
              shown = now;
            } else if (p.kind === 'tool') w.tool(p.id, p.name, p.args);
            else if (p.kind === 'tool_result') w.result(p.id, p.text, [], p.isError);
            else if (p.kind === 'restart') {
              // it answers again: what it wrote so far is replaced
              w.data('restart', {});
              full = '';
              shown = '';
            }
          });
          // what was held back in case it began the actions fence, but didn't (an answer ending in `code`)
          const rest = readable(full, true);
          if (rest.length > shown.length && rest.startsWith(shown)) w.text(rest.slice(shown.length));
          w.data('answer', a);
        } catch (e) {
          write({ type: 'error', errorText: (e instanceof Error && e.message) || String(e) });
        } finally {
          w.finish();
          if (!gone) out.close();
        }
      })();
    },
    cancel: () => void (gone = true),
  });
}
