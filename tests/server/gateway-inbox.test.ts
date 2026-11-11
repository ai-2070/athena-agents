import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { bus, listProjects, saveProjects, setActiveProject } from '../../server/store.ts';
import { getGatewayInstance, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const opened: GatewayStateAdapter[] = [];
let nextAccount = 1000;
async function inbox() {
  const instance = saveGatewayInstance(gatewayConfig(String(nextAccount++)));
  // Account IDs are explicit; this fixture's normalized messages use the configured one.
  const state = new GatewayStateAdapter(instance.id);
  opened.push(state);
  await state.connect();
  const input = (id = '1', conversationId = '123') => ({
    ...gatewayInput(id, conversationId),
    accountId: instance.accountId,
  });
  return { instance, state, inbox: new GatewayInbox(state), input };
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((state) => state.disconnect()));
});

describe('gateway application inbox', () => {
  it('durably binds and deduplicates messages, including replay after a destination change', async () => {
    const fixture = await inbox();
    const event = fixture.inbox.accept(fixture.input())!;
    expect(event.status).toBe('queued');
    const renamed = saveGatewayInstance(
      { ...gatewayConfig(fixture.instance.accountId), name: 'Renamed' },
      fixture.instance.id,
    );
    expect(renamed.routeGeneration).toBe(1);
    expect(fixture.inbox.accept({ ...fixture.input(), sourceEventId: 'another-delivery' })?.id).toBe(event.id);
    const first = listProjects()[0];
    const second = { ...first, id: 'inbox-other', name: 'Other' };
    saveProjects([...listProjects(), second]);
    setActiveProject(second.id);
    expect(fixture.inbox.accept(fixture.input('2'))?.route.projectId).toBe(first.id);
    saveGatewayInstance({ ...gatewayConfig(fixture.instance.accountId), projectId: second.id }, fixture.instance.id);
    expect(fixture.inbox.accept(fixture.input())?.id).toBe(event.id);
    const newMessage = fixture.inbox.accept(fixture.input('3'))!;
    expect(newMessage.bindingId).not.toBe(event.bindingId);
    expect(newMessage.route.projectId).toBe(second.id);
    await fixture.state.disconnect();
    await fixture.state.connect();
    expect(fixture.inbox.list()).toHaveLength(3);
    expect(fixture.inbox.accept(fixture.input())?.route.projectId).toBe(first.id);
  });

  it('rejects unauthorized identities, wrong accounts and scopes before creating receipts', async () => {
    const fixture = await inbox();
    for (const input of [
      { ...fixture.input(), actor: { id: '777', label: 'Alice', kind: 'user' } },
      { ...fixture.input(), actor: { id: '123', label: 'Alice', kind: 'bot' } },
      { ...fixture.input(), actor: { id: '123', label: 'Alice', kind: 'anonymous' } },
      { ...fixture.input(), accountId: 'other-account' },
      { ...fixture.input(), platform: 'slack' },
      { ...fixture.input(), directMessage: false, conversationId: '-200', triggered: true },
    ])
      expect(fixture.inbox.accept(input)).toBeNull();
    expect(fixture.inbox.list()).toEqual([]);
    expect(fs.existsSync(fixture.state.inboxFile())).toBe(false);
  });

  it('starts shared topics on a mention/reply and accepts only the exact configured topic afterward', async () => {
    const fixture = await inbox();
    const shared = { ...fixture.input(), conversationId: '-100', threadId: '7', directMessage: false };
    expect(fixture.inbox.accept(shared)).toBeNull();
    expect(fixture.inbox.accept({ ...shared, triggered: true })).not.toBeNull();
    expect(fixture.inbox.accept({ ...shared, sourceMessageId: '2', sourceEventId: '2' })).not.toBeNull();
    expect(fixture.inbox.accept({ ...shared, threadId: '8', triggered: true })).toBeNull();
    expect(fixture.inbox.accept({ ...shared, threadId: '', triggered: true })).toBeNull();
  });

  it('accepts file-only messages as descriptors and refuses functions or URL fields', async () => {
    const fixture = await inbox();
    const input = {
      ...fixture.input(),
      text: '',
      media: [{ kind: 'file', fileId: 'private-id', name: 'plan.pdf', size: 100 }],
    };
    const event = fixture.inbox.accept(input);
    expect(event?.input.text).toBe('');
    expect(event?.input.media[0].fileId).toBe('private-id');
    expect(event?.status).toBe('waiting-files');
    expect(fixture.inbox.claimNext()).toBeNull();
    expect(() =>
      fixture.inbox.accept({ ...input, media: [{ ...input.media[0], fetchData: () => 'secret' }] }),
    ).toThrow();
    expect(() =>
      fixture.inbox.accept({ ...input, media: [{ ...input.media[0], url: 'https://example.com/?token=secret' }] }),
    ).toThrow();
    expect(fs.readFileSync(fixture.state.inboxFile(), 'utf8')).not.toContain('secret');
  });

  it('preserves conversation order while unrelated conversations can progress', async () => {
    const fixture = await inbox();
    const first = fixture.inbox.accept(fixture.input())!;
    const second = fixture.inbox.accept(fixture.input('2'))!;
    const other = fixture.inbox.accept(fixture.input('3', '456'))!;
    const claimed = fixture.inbox.claimNext()!;
    expect(claimed.id).toBe(first.id);
    expect(claimed.operationId).toBeTruthy();
    expect(fixture.inbox.claimNext()?.id).toBe(other.id);
    expect(fixture.inbox.claimNext()).toBeNull();
    expect(() => fixture.inbox.complete(first.id, 'wrong-operation')).toThrow('no longer running');
    fixture.inbox.complete(first.id, claimed.operationId!);
    expect(fixture.inbox.claimNext()?.id).toBe(second.id);
  });

  it('rechecks revoked senders and destinations before claiming queued work', async () => {
    const fixture = await inbox();
    fixture.inbox.accept(fixture.input());
    saveGatewayInstance(
      { ...gatewayConfig(fixture.instance.accountId), senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } },
      fixture.instance.id,
    );
    expect(fixture.inbox.claimNext()).toBeNull();
    expect(fixture.inbox.list()[0].status).toBe('needs-review');
    expect(fixture.inbox.accept(fixture.input('2'))).toBeNull();
    expect(getGatewayInstance(fixture.instance.id).enabled).toBe(true);
  });

  it('records edits separately and never starts a second run for an edit', async () => {
    const fixture = await inbox();
    const original = fixture.inbox.accept(fixture.input())!;
    const edit = { ...fixture.input(), kind: 'edit', sourceEventId: 'edit-1', text: 'Corrected' };
    const edited = fixture.inbox.accept(edit)!;
    expect(edited.id).not.toBe(original.id);
    expect(edited.status).toBe('needs-review');
    expect(fixture.inbox.accept(edit)?.id).toBe(edited.id);
    expect(fixture.inbox.list()).toHaveLength(2);
    expect(fixture.inbox.list()[0].status).toBe('needs-review');
    expect(fixture.inbox.claimNext()).toBeNull();
    expect(fixture.inbox.accept({ ...edit, sourceMessageId: 'missing' })).toBeNull();
  });

  it('retains an empty edit to an existing source and holds its original assignment', async () => {
    const fixture = await inbox();
    fixture.inbox.accept(fixture.input());
    expect(fixture.inbox.accept({ ...fixture.input('2'), text: '', media: [] })).toBeNull();
    const edit = { ...fixture.input(), kind: 'edit', sourceEventId: 'empty-edit', text: '', media: [] };
    expect(fixture.inbox.accept(edit)?.status).toBe('needs-review');
    expect(fixture.inbox.list()[0].status).toBe('needs-review');
    expect(fixture.inbox.accept({ ...edit, sourceMessageId: 'missing' })).toBeNull();
    expect(fixture.inbox.list()).toHaveLength(2);
    expect(fixture.inbox.claimNext()).toBeNull();
  });

  it('keeps raw message content off event notifications and fails closed on storage corruption', async () => {
    const fixture = await inbox();
    const notifications: unknown[] = [];
    const listener = (event: unknown) => notifications.push(event);
    bus.on('event', listener);
    try {
      fixture.inbox.accept({ ...fixture.input(), text: 'private-content' });
    } finally {
      bus.off('event', listener);
    }
    expect(JSON.stringify(notifications)).not.toContain('private-content');
    fs.writeFileSync(fixture.state.inboxFile(), '{broken');
    expect(() => fixture.inbox.accept(fixture.input('2'))).toThrow('unreadable');
    expect(fs.readFileSync(fixture.state.inboxFile(), 'utf8')).toBe('{broken');
    await fixture.state.disconnect();
    expect(() => fixture.inbox.list()).toThrow('not connected');
  });

  it('recovers a committed inbox after process death without a blind second run', async () => {
    const instance = saveGatewayInstance(gatewayConfig('999-crash'));
    const input = { ...gatewayInput(), accountId: instance.accountId };
    const code = `import { GatewayStateAdapter } from './server/gateways/state.ts';
import { GatewayInbox } from './server/gateways/inbox.ts';
const state = new GatewayStateAdapter(${JSON.stringify(instance.id)}); await state.connect();
const inbox = new GatewayInbox(state); inbox.accept(${JSON.stringify(input)}); inbox.claimNext(); console.log('committed'); setInterval(()=>{},1000);`;
    const child = spawn('bun', ['--eval', code], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const ready = await Promise.race([
        once(child.stdout!, 'data').then((chunks: unknown[]) => String(chunks[0])),
        once(child, 'exit').then(() => {
          throw new Error('Inbox fixture exited early.');
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Inbox fixture timed out.')), 10000).unref();
        }),
      ]);
      expect(ready).toContain('committed');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const state = new GatewayStateAdapter(instance.id);
      opened.push(state);
      await state.connect();
      const recovered = new GatewayInbox(state);
      const operationId = recovered.list()[0].operationId;
      recovered.recover();
      expect(recovered.list()[0]).toMatchObject({ status: 'needs-review', operationId });
      expect(recovered.accept(input)?.id).toBe(recovered.list()[0].id);
      expect(recovered.claimNext()).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
