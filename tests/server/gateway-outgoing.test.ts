import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeProject, listProjects, saveProjects, setActiveProject, withProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import type { GatewayTarget } from '../../shared/types.ts';
import { ensureBrain } from '../../server/projects.ts';
import { dataPath, HOME, IS_WIN } from '../../server/util.ts';
import { saveGatewayInstance, withGatewayRoute } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayReplies, GatewaySendError } from '../../server/gateways/replies.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { selectGatewayDocuments, verifyGatewayDocument } from '../../server/gateways/outgoing.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const cleanups: (() => Promise<void>)[] = [];
let account = 70000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(limits = gatewayConfig().fileLimits, target: GatewayTarget = { kind: 'brain' }) {
  const config = { ...gatewayConfig(String(account++)), fileLimits: limits, target };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect(); cleanups.push(() => state.disconnect());
  const inbox = new GatewayInbox(state); const signal = new AbortController().signal;
  inbox.accept({ ...gatewayInput(), accountId: instance.accountId }); const claimed = inbox.claimNext()!;
  inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, signal));
  const folder = path.join(withGatewayRoute(claimed.route, ensureBrain), `outgoing-${account}`); fs.mkdirSync(folder, { recursive: true });
  const file = (name: string, text = 'hello') => { const target = path.join(folder, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target; };
  const finish = () => inbox.finishDispatch(claimed.id, claimed.operationId!, 'Final answer');
  const sender = (upload: (text: string) => Promise<string>, sent: string[] = []) => {
    const worker = new GatewayReplies(inbox, async (_event, text) => { sent.push(text); return 'text-id'; }, signal, () => true,
      async (event, selected, abort) => { let bytes: Buffer; try { bytes = await verifyGatewayDocument(event, selected, abort); } catch { throw new GatewaySendError('failed'); } return upload(bytes.toString()); });
    cleanups.push(() => worker.stop()); return worker;
  };
  return { config, instance, state, inbox, signal, event: claimed, file, finish, sender };
}

describe('selected gateway documents', () => {
  it('uses the target agent’s workspace and rejects runtime and other-project files even with a broad workspace', async () => {
    const workspace = path.join(HOME, `outgoing-agent-${account}`); fs.mkdirSync(workspace, { recursive: true });
    const agent = withProject(listProjects()[0], () => newAgent({ name: 'File target', workspace }));
    const f = await fixture(undefined, { kind: 'agent', id: agent.id });
    const own = path.join(workspace, 'own.txt'); fs.writeFileSync(own, 'own file');
    await expect(selectGatewayDocuments(f.inbox, f.event.id, { paths: [f.file('brain-only.txt')] }, f.signal)).rejects.toMatchObject({ status: 400 });
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [own] }, f.signal);
    expect((await verifyGatewayDocument(f.inbox.list()[0], f.inbox.list()[0].outgoing![0], f.signal)).toString()).toBe('own file');
    const broad = withProject(listProjects()[0], () => newAgent({ name: 'Broad target', workspace: path.dirname(HOME) }));
    const g = await fixture(undefined, { kind: 'agent', id: broad.id });
    const privateFile = dataPath(`private-outgoing-${account}.txt`); fs.writeFileSync(privateFile, 'private state');
    await expect(selectGatewayDocuments(g.inbox, g.event.id, { paths: [privateFile] }, g.signal)).rejects.toMatchObject({ status: 400 });
    const otherRoot = path.join(HOME, `unrelated-outgoing-${account}`); fs.mkdirSync(otherRoot, { recursive: true });
    const otherFile = path.join(otherRoot, 'report.txt'); fs.writeFileSync(otherFile, 'other project');
    saveProjects([...listProjects(), { ...listProjects()[0], id: `outgoing-private-project-${account}`, brainPath: otherRoot }]);
    await expect(selectGatewayDocuments(g.inbox, g.event.id, { paths: [otherFile] }, g.signal)).rejects.toMatchObject({ status: 400 });
  });

  it('saves explicit selections, sends text first, and retains confirmed files across retries', async () => {
    const f = await fixture(); const one = f.file('one.txt', 'one'); const two = f.file('two.txt', 'two');
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [one, two] }, f.signal);
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [one, two] }, f.signal);
    const sent: string[] = []; let fail = true;
    const worker = f.sender(async (text) => { sent.push(text); if (text === 'two' && fail) throw new Error('private URL'); return `file-${text}`; }, sent);
    await worker.wake(); expect(sent).toEqual([]);
    f.finish(); await worker.wake();
    expect(sent).toEqual(['Final answer', 'one', 'two']);
    expect(f.inbox.list()[0].outgoing?.map((file) => file.status)).toEqual(['sent', 'uncertain']);
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover(); await worker.wake();
    expect(sent).toHaveLength(3);
    f.inbox.accept({ ...gatewayInput('2'), accountId: f.instance.accountId }); expect(f.inbox.claimNext()).toBeNull();
    fail = false; f.inbox.changeOutgoing(f.event.id, 1, 'retry'); await worker.wake();
    expect(sent).toEqual(['Final answer', 'one', 'two', 'two']);
    expect(f.inbox.list()[0].outgoing?.[0].remoteId).toBe('file-one');
    expect(f.inbox.claimNext()?.input.sourceMessageId).toBe('2');
    expect(JSON.stringify(f.inbox.list())).not.toContain('private URL');
  });

  it('rejects changed bytes, then permits skipping the file without resending text', async () => {
    const f = await fixture(); const target = f.file('report.txt');
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [target] }, f.signal); f.finish();
    fs.writeFileSync(target, 'other'); let uploads = 0;
    const worker = f.sender(async () => { uploads++; return 'unexpected'; }); await worker.wake();
    expect(uploads).toBe(0); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed');
    f.inbox.changeOutgoing(f.event.id, 0, 'skip'); await worker.wake();
    expect(f.inbox.list()[0].outgoing?.[0].status).toBe('skipped');
    expect(f.inbox.list()[0].reply?.parts[0].remoteId).toBe('text-id');
  });

  it('rejects credentials, private state, folders, hard links, oversized files and paths outside the target', async () => {
    const f = await fixture(); const target = f.file('allowed.txt');
    const hard = path.join(path.dirname(target), 'hard.txt'); fs.linkSync(target, hard);
    const outside = path.join(HOME, `outside-${account}.txt`); fs.writeFileSync(outside, 'outside');
    const runtime = dataPath('outgoing-private.txt'); fs.writeFileSync(runtime, 'private');
    for (const denied of [f.file('.env'), f.file('secret.key'), f.file('.dashboard/chats.json'), path.dirname(target), hard, outside, runtime, f.file('large.txt', 'a'.repeat(1025))]) {
      await expect(selectGatewayDocuments(f.inbox, f.event.id, { paths: [denied] }, f.signal)).rejects.toMatchObject({ status: 400 });
    }
    expect(f.inbox.list()[0].outgoing).toBeUndefined();
    await expect(selectGatewayDocuments(f.inbox, f.event.id, { paths: [target], unexpected: true }, f.signal)).rejects.toMatchObject({ status: 400 });
  });

  it.skipIf(IS_WIN)('refuses symlinks escaping the target and detects replacement after selection', async () => {
    const f = await fixture(); const target = f.file('safe.txt');
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [target] }, f.signal);
    const outside = path.join(HOME, `outside-link-${account}.txt`); fs.writeFileSync(outside, 'hello');
    fs.unlinkSync(target); fs.symlinkSync(outside, target);
    await expect(verifyGatewayDocument(f.inbox.list()[0], f.inbox.list()[0].outgoing![0], f.signal)).rejects.toThrow();
  });

  it('keeps the selected project pinned and refuses revoked sender access', async () => {
    const f = await fixture(); const target = f.file('pinned.txt'); const first = withGatewayRoute(f.event.route, activeProject);
    const other = { ...first, id: `outgoing-other-${account}`, brainPath: path.join(HOME, `other-${account}`) };
    saveProjects([...listProjects(), other]); setActiveProject(other.id);
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [target] }, f.signal);
    expect(activeProject().id).toBe(other.id);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    await expect(verifyGatewayDocument(f.inbox.list()[0], f.inbox.list()[0].outgoing![0], f.signal)).rejects.toThrow();
  });

  it('reserves failed attempts across restarts and marks interrupted uploads uncertain', async () => {
    const f = await fixture({ perFileBytes: 5, perMessageBytes: 10, filesPerMessage: 2, dailyBytes: 10 });
    await selectGatewayDocuments(f.inbox, f.event.id, { paths: [f.file('quota.txt')] }, f.signal); f.finish();
    const worker = f.sender(async () => { throw new GatewaySendError('retry', 7000); }); await worker.wake();
    expect(f.inbox.list()[0].outgoing?.[0].attempts).toHaveLength(1);
    expect(f.inbox.claimOutgoing()).toBeNull();
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    expect(f.inbox.list()[0].outgoing?.[0].attempts[0].bytes).toBe(5);
    vi.spyOn(Date, 'now').mockReturnValue(f.inbox.list()[0].outgoing![0].retryAt! + 1);
    expect(f.inbox.claimOutgoing()?.index).toBe(0);
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    expect(f.inbox.list()[0].outgoing?.[0].status).toBe('uncertain');
    f.inbox.changeOutgoing(f.event.id, 0, 'retry'); await worker.wake();
    expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed');
    expect(f.inbox.list()[0].outgoing?.[0].attempts).toHaveLength(2);
  });

  it('does not upload a completed assignment’s pending files after a source edit', async () => {
    const f = await fixture(); await selectGatewayDocuments(f.inbox, f.event.id, { paths: [f.file('edited.txt')] }, f.signal); f.finish();
    f.inbox.accept({ ...f.event.input, kind: 'edit', sourceEventId: 'edit-1' });
    let uploads = 0; await f.sender(async () => { uploads++; return 'unexpected'; }).wake();
    expect(uploads).toBe(0); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed');
  });
});
