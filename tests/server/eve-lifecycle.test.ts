import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { admitExecution, readExecution, updateExecution } from '../../server/execution.ts';
import {
  attachSession,
  beginRun,
  bindSession,
  conversationBinding,
  invalidateConversation,
  readBinding,
  readRun,
  sessionContext,
  setRunStatus,
  settleRun,
} from '../../server/eve/state.ts';
import { prepareEveRecovery, retireEveBindings } from '../../server/eve/recovery.ts';
import { privateDataPath } from '../../server/private.ts';
import { writeJSON } from '../../server/util.ts';
import type { ExecutionRun } from '../../shared/types.ts';

function fixture(id: string, parent?: ExecutionRun) {
  const project = activeProject();
  const agent = newAgent({ name: id, engine: 'eve' });
  const chat = chats.create(agent.id);
  const binding = bindSession(agent, chat, project, 'lifecycle');
  attachSession(binding.id, `session-${id}`);
  const run: ExecutionRun = {
    id,
    projectId: project.id,
    agentId: agent.id,
    chatId: chat.id,
    engine: 'eve',
    parentRunId: parent?.id || null,
    ownerAgentId: parent?.ownerAgentId || agent.id,
    ownerChatId: parent?.ownerChatId || chat.id,
    depth: parent ? parent.depth + 1 : 0,
    text: 'Work',
    from: null,
    attachments: [],
    startedAt: Date.now(),
    status: 'running',
  };
  admitExecution(run);
  beginRun(id, binding.id, run.depth, run.parentRunId);
  setRunStatus(id, 'running', 'delivery');
  return { project, agent, chat, binding, run };
}

describe('native session retirement', () => {
  it('lets an admitted turn finish after Clear memory, but never reuses its binding', async () => {
    const f = fixture('clear-active');
    invalidateConversation(f.project.id, f.chat.id);
    expect(sessionContext(f.binding.id).chat.id).toBe(f.chat.id);
    expect(conversationBinding(f.project.id, f.agent.id, f.chat.id, 'lifecycle')).toBeNull();
    settleRun(f.run.id, 'completed', 'Last answer');
    expect(readBinding(f.binding.id)?.retired).toBe(true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    try {
      await retireEveBindings({ url: 'http://127.0.0.1:1', token: 'fixture' }, f.binding);
      await retireEveBindings({ url: 'http://127.0.0.1:1', token: 'fixture' }, f.binding);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain(`/session/session-${f.run.id}/end`);
      expect(readBinding(f.binding.id)?.runtimeEnded).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  it('retires deleted owners and changed engines before the worker starts', () => {
    const deleted = fixture('deleted-session');
    chats.remove(deleted.agent.id, deleted.chat.id);
    const changed = fixture('changed-engine');
    agents.save({ ...changed.agent, engine: 'codex' });
    prepareEveRecovery();
    for (const f of [deleted, changed]) {
      expect(readRun(f.run.id)?.status).toBe('interrupted');
      expect(readBinding(f.binding.id)?.retired).toBe(true);
    }
  });

  it('interrupts incompatible native state without migrating or resending it', () => {
    const f = fixture('old-runtime');
    writeJSON(privateDataPath('runtime', 'eve', 'bindings', `${f.binding.id}.json`), {
      ...readBinding(f.binding.id)!,
      runtimeVersion: 'older-build',
    });
    expect(() => sessionContext(f.binding.id)).toThrow('updated');
    prepareEveRecovery();
    expect(readRun(f.run.id)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('Check its results'),
    });
    expect(readBinding(f.binding.id)?.retired).toBe(true);
  });
});

describe('native children after a parent finishes', () => {
  it('recovers only an exact saved descendant and keeps its old parent receipt', () => {
    const parent = fixture('finished-parent');
    const child = fixture('remaining-child', parent.run);
    settleRun(parent.run.id, 'completed', 'Delegated');
    updateExecution(parent.run.id, { status: 'completed', settled: true, endedAt: Date.now() - 24 * 60 * 60 * 1000 });
    expect(readExecution().runs.some((run) => run.id === parent.run.id)).toBe(true);
    prepareEveRecovery();
    expect(readRun(child.run.id)?.status).toBe('running');
    const foreign = fixture('foreign-child', { ...parent.run, ownerChatId: 'another-chat' });
    prepareEveRecovery();
    expect(readRun(foreign.run.id)?.status).toBe('interrupted');
  });
});
