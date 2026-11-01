import crypto from 'node:crypto';
import { agents, chats, emit, withProject } from '../store.ts';
import { liveChat } from '../engines/index.ts';
import { keepToolImages } from '../toolimages.ts';
import { markProjected, readRun, transcriptContext } from './state.ts';
import { EveProjectionError } from './projection.ts';
import { readAdmission } from './admission.ts';
import { measuredBy } from '../compaction.ts';
import { readExecution } from '../execution.ts';
import type { RunEvent } from '../../shared/types.ts';

/** The chat and its stable fact IDs are saved together, before advancing or broadcasting. */
export function projectTranscript(runId: string): void {
  const run = readRun(runId);
  if (!run) throw new Error('No such Eve run.');
  const { binding, project, agent, chat: saved } = transcriptContext(run.bindingId);
  withProject(project, () => {
    const chat = liveChat(binding.chatId, project.id) || saved;
    if (chat._deleted) return;
    for (let i = run.projected || 0; i < run.events.length; i++) {
      const fact = run.events[i]!;
      const sourceId = `eve:${runId}:${fact.id}`;
      let event: RunEvent = fact.event;
      let publish = false;
      if (event.kind === 'tool_result') {
        const callId = event.id;
        const tool = chat.items.findLast((item) => item.type === 'tool' && item.id === callId && item.sourceId?.startsWith(`eve:${runId}:`));
        if (!tool || tool.type !== 'tool') throw new EveProjectionError('The saved Eve tool result has no original call.');
        if (tool.resultSourceId !== sourceId) {
          const images = keepToolImages(agent.id, chat.id, event.images);
          Object.assign(tool, { resultSourceId: sourceId, result: event.text || '', images, isError: !!event.isError, status: event.isError ? 'error' : 'done' });
          event = { ...event, images };
          publish = true;
        }
      } else if (event.kind === 'model') {
        const fresh = agents.get(agent.id);
        if (fresh && fresh.lastModel !== event.model) agents.save({ ...fresh, lastModel: event.model, lastModelAt: Date.now() });
        publish = true;
      } else if (!chat.items.some((item) => item.sourceId === sourceId)) {
        const ts = Date.now();
        if (event.kind === 'text') chat.items.push({ type: 'assistant', text: event.text, sourceId, ts });
        else if (event.kind === 'tool') chat.items.push({ type: 'tool', id: event.id, name: event.name, args: event.args, result: null, status: 'running', sourceId, ts });
        else if (event.kind === 'usage') {
          const cost = event.costUsd === undefined ? 'Cost not reported' : `$${event.costUsd.toFixed(4)}`;
          const tokens = event.inputTokens + event.outputTokens;
          chat.items.push({ type: 'meta', text: `${event.summary ? 'Memory summary · ' : ''}${cost} · ${tokens} tokens${event.cacheReadTokens ? ` · ${event.cacheReadTokens} from cache` : ''}`, sourceId, ts });
          if (!event.summary) {
            const selection = readAdmission(runId)?.selection;
            const engine = readExecution().runs.find((receipt) => receipt.id === runId)?.engine || agent.engine;
            const measured = { ...agent, engine, model: selection?.model || agent.model, provider: selection?.provider || agent.provider };
            const window = selection?.contextWindow;
            chat.context = { tokens, ...(window ? { window } : {}), items: chat.items.length, at: ts, by: measuredBy(measured) };
          }
        }
        else if (event.kind === 'compacted') {
          const id = `eve${crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 24)}`;
          chat.items.push({ type: 'compaction', id, text: '', mode: 'engine', trigger: 'auto', upto: chat.items.length, sourceId, ts });
          delete chat.context;
        } else throw new EveProjectionError('This Eve fact cannot be added to the saved conversation.');
        publish = true;
      }
      chats.save(chat);
      markProjected(runId, i + 1);
      if (!publish) continue;
      if (event.kind === 'compacted') {
        const item = chat.items.find((item) => item.sourceId === sourceId);
        if (item?.type === 'compaction') emit('compacted', { agentId: agent.id, chatId: chat.id, itemId: item.id });
      } else emit('run', { runId, agentId: agent.id, chatId: chat.id, event, eventId: sourceId });
    }
  });
}
