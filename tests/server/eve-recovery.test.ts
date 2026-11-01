import http from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { decide, ensureDurableApproval, listApprovals } from '../../server/approvals.ts';
import { attachSession, beginRun, bindSession, readRun, setRunStatus } from '../../server/eve/state.ts';
import { prepareOperation, readOperation, saveOperation } from '../../server/eve/operations.ts';
import { deliverApprovalDecisions, eveClient, reconcileSnapshot, recoverEveRuns, stopEveRun } from '../../server/eve/recovery.ts';
import { runInfo } from '../../server/engines/index.ts';
import type { SessionSnapshot, SessionStreamEvent } from 'eve/client';

function fixture(id: string, parent: string | null = null) {
  const agent = agents.save(newAgent({ name: id }));
  const chat = chats.create(agent.id, id);
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  beginRun(id, binding.id, parent ? 1 : 0, parent);
  setRunStatus(id, 'running', 'delivery');
  return { agent, chat, binding };
}

function waiting(id: string) {
  const own = fixture(id);
  attachSession(own.binding.id, 'session');
  const operation = prepareOperation({ runId: id, bindingId: own.binding.id, sessionId: 'session', callId: 'call', name: 'write_file', args: { path: 'report', content: 'once' }, origin: 'builtin:write_file', risk: 'low' });
  const approval = ensureDurableApproval(operation.id, { title: 'Write', agentId: own.agent.id, data: { runId: id, args: operation.args } });
  saveOperation({ ...operation, approvalId: approval.id, status: 'waiting' });
  return { ...own, operation, approval };
}

function snapshot(facts: readonly SessionStreamEvent[]): SessionSnapshot {
  return { events: facts, session: { sessionId: 'session', streamIndex: facts.length } };
}

const fact = (input: Omit<SessionStreamEvent, 'meta'>, line: number): SessionStreamEvent => ({ ...input, meta: { position: { line, index: 0 }, at: new Date().toISOString() } }) as SessionStreamEvent;
const parked = () => snapshot([
  fact({ type: 'delivery.admitted', data: { deliveryId: 'delivery' } }, 0),
  fact({ type: 'delivery.consumed', data: { deliveryId: 'delivery', turnId: 'turn', parts: [] } }, 1),
  fact({ type: 'call.requested', data: { callId: 'call', owner: { runId: 'model' }, capability: { kind: 'tool', name: 'write_file' }, input: { path: 'report', content: 'once' } } }, 2),
  fact({ type: 'interaction.opened', data: { interactionId: 'interaction', subject: { callId: 'call' }, request: { kind: 'approval', prompt: 'Write?' } } }, 3),
  fact({ type: 'turn.paused', data: { turnId: 'turn', awaiting: [{ interactionId: 'interaction' }] } }, 4),
]);

describe('Eve restart reconciliation', () => {
  it('replays one original tool call, restores its wait and settles its turn only once', () => {
    const { operation } = waiting('recovery-facts');
    const prefix = parked();
    expect(reconcileSnapshot('recovery-facts', prefix)).toHaveLength(1);
    expect(reconcileSnapshot('recovery-facts', prefix)).toEqual([]);
    expect(readRun('recovery-facts')?.status).toBe('waiting');
    expect(readOperation(operation.id)?.interactionId).toBe('interaction');
    const finished = snapshot([...prefix.events,
      fact({ type: 'interaction.settled', data: { interactionId: 'interaction', outcome: 'accepted' } }, 5),
      fact({ type: 'call.settled', data: { callId: 'call', outcome: 'completed', output: { text: 'Wrote report' } } }, 6),
      fact({ type: 'content.completed', data: { partId: 'part', runId: 'model', kind: 'text', phase: 'reply', value: 'Done' } }, 7),
      fact({ type: 'turn.settled', data: { turnId: 'turn', outcome: 'completed', reply: ['part'] } }, 8),
    ]);
    expect(reconcileSnapshot('recovery-facts', finished)).toHaveLength(2);
    expect(readRun('recovery-facts')?.status).toBe('completed');
    expect(reconcileSnapshot('recovery-facts', finished)).toEqual([]);
    expect(readRun('recovery-facts')?.events).toHaveLength(3);
    expect(runInfo('recovery-facts')).toBeNull();
  });

  it('retries a lost approval receipt with the same input key', async () => {
    const { binding, operation, approval } = waiting('recovery-answer');
    reconcileSnapshot('recovery-answer', parked());
    decide(approval.id, { approved: true });
    const inputs: unknown[] = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      inputs.push(JSON.parse(body));
      if (inputs.length === 1) return void request.socket.destroy();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, sessionId: 'session', deliveryId: 'same-answer' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    try {
      const client = eveClient({ url: `http://127.0.0.1:${address.port}`, token: 'fixture' }, binding.id);
      await expect(deliverApprovalDecisions('recovery-answer', client)).rejects.toThrow();
      expect(readOperation(operation.id)?.responseDeliveryId).toBeUndefined();
      await deliverApprovalDecisions('recovery-answer', client);
      await deliverApprovalDecisions('recovery-answer', client);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toEqual(inputs[1]);
      expect(readOperation(operation.id)?.responseDeliveryId).toBe('same-answer');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopEveRun('recovery-answer');
    }
  });

  it('withdraws consent with the abandoned native interaction', async () => {
    const { operation, approval } = waiting('recovery-withdrawn');
    const prefix = parked();
    reconcileSnapshot('recovery-withdrawn', prefix);
    reconcileSnapshot('recovery-withdrawn', snapshot([...prefix.events, fact({ type: 'interaction.settled', data: { interactionId: 'interaction', outcome: 'withdrawn' } }, 5)]));
    expect(readOperation(operation.id)?.status).toBe('cancelled');
    expect(decide(approval.id, { approved: true })).toBe(false);
    await stopEveRun('recovery-withdrawn');
  });

  it('interrupts orphaned children and unknown effects without starting a new turn', async () => {
    saveSettings({ brainApproves: false });
    fixture('orphan-child', 'vanished-cli-parent');
    const { binding } = fixture('unknown-effect');
    const operation = prepareOperation({ runId: 'unknown-effect', bindingId: binding.id, sessionId: 'session', callId: 'send', name: 'send', args: {}, origin: 'builtin:send', risk: 'high' });
    saveOperation({ ...operation, status: 'running' });
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await recoverEveRuns({ url: 'http://127.0.0.1:9876', token: 'fixture' });
      expect(transport.mock.calls.every(([url]) => String(url).endsWith('/session/session/end'))).toBe(true);
    } finally { transport.mockRestore(); }
    expect(readRun('orphan-child')?.status).toBe('interrupted');
    expect(readRun('unknown-effect')?.status).toBe('interrupted');
    expect(readOperation(operation.id)?.status).toBe('uncertain');
    expect(listApprovals().some((item) => item.title === 'Check the outcome of send')).toBe(true);
  });
});
