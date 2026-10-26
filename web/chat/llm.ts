// OpenUI's chat state talks to the dashboard here. Sending a message posts it to the agent's chat (the
// server keeps the history and runs the agent); the run's live events then come over the dashboard's
// WebSocket and are turned into the AG-UI events OpenUI streams into the thread.
import { EventType } from '@openuidev/react-headless';
import type { AGUIEvent, ChatLLM } from '@openuidev/react-headless';
import { onEvent as onServerEvent, POST } from '../core.ts';
import { readUserContent, toolContent } from './convert.ts';
import type { RunEvent, ServerEvent } from '../../shared/types.ts';

export interface RunHooks {
  /** Progress lines ("Using read_file…"); not part of the message. */
  onStatus?: (text: string) => void;
  /** The message could not be sent (the server said why). */
  onSendFailed?: (message: string) => void;
  /** Whether the server still has a run going in this chat (for when the socket missed the end). */
  isRunning?: (chatId: string) => boolean;
}

/** What the adapter needs from the page (swapped in tests). */
export interface LlmDeps {
  onEvent: (fn: (ev: ServerEvent) => void) => () => void;
  post: <T>(path: string, body: unknown) => Promise<T>;
  /** How often to check that the server still runs it (ms). */
  checkEvery?: number;
}

interface LiveRun {
  chatId: string;
  runId: string | null;
  queue: { runId: unknown; event: RunEvent }[];
  wake: (() => void) | null;
  ended: boolean;
  off: () => void;
}

export function dashboardLLM(agentId: string, hooks: RunHooks = {}, deps: LlmDeps = { onEvent: onServerEvent, post: POST }): ChatLLM {
  let live: LiveRun | null = null;
  const end = (r: LiveRun) => {
    r.ended = true;
    r.wake?.();
  };
  return {
    async send({ threadId, messages, signal }) {
      const last = messages[messages.length - 1];
      const { text, attachments } = last?.role === 'user' ? readUserContent(last) : { text: '', attachments: [] };
      const r: LiveRun = { chatId: threadId, runId: null, queue: [], wake: null, ended: false, off: () => {} };
      // listen before posting: the server announces the run before it answers
      r.off = deps.onEvent((ev) => {
        if (ev.type !== 'run' || ev.chatId !== threadId) return;
        if (r.runId && ev.runId !== r.runId) return;
        r.queue.push({ runId: ev.runId, event: ev.event as RunEvent });
        r.wake?.();
      });
      live = r;
      try {
        const res = await deps.post<{ runId?: string }>(`/agents/${agentId}/chats/${threadId}/messages`, { text, attachments });
        if (!res?.runId) end(r);
        else {
          r.runId = res.runId;
          r.queue = r.queue.filter((q) => q.runId === r.runId);
        }
      } catch (e) {
        r.off();
        live = null;
        const message = (e as Error).message || 'Could not send.';
        hooks.onSendFailed?.(message);
        return new Response(JSON.stringify({ error: message }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      signal.addEventListener('abort', () => {
        deps.post(`/agents/${agentId}/chats/${threadId}/stop`, {}).catch(() => {});
        end(r);
      });
      return new Response(null, { status: 200 });
    },
    streamProtocol: {
      async *parse(): AsyncIterable<AGUIEvent> {
        const r = live;
        if (!r) return;
        const textId = `live-${r.runId || 'run'}`;
        // the socket may miss the end (a reconnect): stop when the server no longer runs it
        let idle = 0;
        let phase: 'thinking' | 'writing' | 'tool' = 'thinking';
        const check = setInterval(() => {
          if (!r.runId || !hooks.isRunning) return;
          idle = hooks.isRunning(r.chatId) ? 0 : idle + 1;
          if (idle >= 2) end(r);
        }, deps.checkEvery ?? 1500);
        try {
          for (;;) {
            while (r.queue.length) {
              const e = r.queue.shift()!.event;
              // (the status line says what it is doing, as the old chat did)
              if (e.kind === 'text' && phase !== 'writing') hooks.onStatus?.(((phase = 'writing'), 'Writing…'));
              else if (e.kind === 'tool') hooks.onStatus?.(((phase = 'tool'), `Using ${e.name}…`));
              else if (e.kind === 'tool_result') hooks.onStatus?.(((phase = 'thinking'), 'Thinking…'));
              if (e.kind === 'text') yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta: e.text } as AGUIEvent;
              else if (e.kind === 'tool') {
                yield { type: EventType.TOOL_CALL_START, toolCallId: e.id, toolCallName: e.name } as AGUIEvent;
                yield { type: EventType.TOOL_CALL_ARGS, toolCallId: e.id, delta: JSON.stringify(e.args ?? {}) } as AGUIEvent;
                yield { type: EventType.TOOL_CALL_END, toolCallId: e.id } as AGUIEvent;
              } else if (e.kind === 'tool_result')
                yield { type: EventType.TOOL_CALL_RESULT, messageId: `${e.id}-result`, toolCallId: e.id, content: toolContent(e.text, e.images), ...(e.isError ? { isError: true } : {}) } as AGUIEvent;
              else if (e.kind === 'status') hooks.onStatus?.(e.text);
              // (an error is saved in the chat and shown when it reloads)
              else if (e.kind === 'done' || e.kind === 'error') return;
            }
            if (r.ended) return;
            await new Promise<void>((resolve) => (r.wake = resolve));
            r.wake = null;
          }
        } finally {
          clearInterval(check);
          r.off();
          if (live === r) live = null;
        }
      },
    },
  };
}
