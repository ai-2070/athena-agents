import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal, GatewayTarget } from '../../shared/types.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import { workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { GatewayInbox, gatewayRetiredFinishReview, gatewayRetiredInboxHistory } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayRetirement } from '../../server/gateways/retirement.ts';
import {
  listGatewayInstances,
  removeGatewayInstance,
  retireGatewayInstance,
  saveGatewayInstance,
} from '../../server/gateways/instances.ts';
import * as ownership from '../../server/gateways/ownership.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 186000;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of closes.splice(0).reverse()) await close();
  for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id);
});
async function fixture(
  mode: 'delivery' | 'work' | 'reserved' = 'delivery',
  target: GatewayTarget = { kind: 'brain' },
  retire = true,
) {
  const config = { ...gatewayConfig(String(account++)), target };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const input = (id = '1', chat = '123') => ({ ...gatewayInput(id, chat), accountId: instance.accountId });
  const event = inbox.accept(input())!;
  const work = inbox.claimNext()!;
  if (mode !== 'reserved')
    inbox.beginDispatch(event.id, work.operationId!, await gatewayConversation(work, new AbortController().signal));
  if (mode === 'delivery') {
    inbox.queueNotice(event.id, 'working');
    inbox.claimNotice();
    inbox.settleNotice(event.id, 'working', { status: 'uncertain' });
    inbox.selectOutgoing(event.id, [
      { path: '/unused/report.txt', name: 'report.txt', size: 5, sha256: 'a'.repeat(64) },
    ]);
    inbox.finishDispatch(event.id, work.operationId!, 'Final saved answer. '.repeat(320));
    inbox.claimReply();
    inbox.settleReply(event.id, 0, { remoteId: 'confirmed-prefix' });
    inbox.claimReply();
    inbox.settleReply(event.id, 1, { status: 'uncertain' });
  }
  const file = state.inboxFile();
  const sdk = dataPath('gateways-runtime', instance.id, 'sdk-state.json');
  const value = new GatewaySupervisor(() => {
    throw new Error('Must not start a transport');
  });
  closes.push(() => value.stop());
  const remove = async () => {
    await state.disconnect();
    await value.removeInstance(instance.id);
  };
  if (retire) await remove();
  const preview = (id = event.id) => gatewayRetiredFinishReview(instance.id, id);
  const body = () => ({ revision: preview().revision, acknowledgeNoSend: true, acknowledgeMayStillRun: true });
  const mutate = (change: (journal: GatewayInboxJournal) => void) => {
    const journal = readJSON<GatewayInboxJournal>(file)!;
    change(journal);
    writeJSON(file, journal);
  };
  return { config, instance, state, inbox, input, event, work, file, sdk, value, preview, body, mutate, remove };
}

it('keeps GET read-only and closes remaining delivery without changing text, confirmed IDs or byte reservations', async () => {
  const f = await fixture();
  const before = gatewayRetiredInboxHistory(f.instance.id)[0];
  const bytes = fs.readFileSync(f.file, 'utf8');
  const sdk = fs.readFileSync(f.sdk, 'utf8');
  const release = await ownership.claimGatewayState(f.instance.id);
  closes.push(release);
  expect(f.preview()).toMatchObject({ kind: 'delivery', canFinish: true, needsPrepare: false });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
  await release();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const body = f.body();
  const result = await f.value.finishRetired(f.instance.id, f.event.id, body);
  expect(result).toMatchObject({ canFinish: false, closedAt: expect.any(Number) });
  expect(gatewayRetiredInboxHistory(f.instance.id)[0]).toEqual({
    ...before,
    deliveryReviews: [{ action: 'finish-local', at: result.closedAt, revision: body.revision }],
    deliveryFinished: { at: result.closedAt, revision: body.revision },
  });
  expect(fs.readFileSync(f.sdk, 'utf8')).toBe(sdk);
  expect(fetch).not.toHaveBeenCalled();
  expect(gatewayRetirement(f.instance.id)?.completedAt).toEqual(expect.any(Number));
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toMatchObject({ status: 409 });
});

it.each(['brain', 'agent', 'team'] as const)(
  'keeps %s native work locally while preserving its original operation and holding earlier requests',
  async (kind) => {
    const agent = newAgent({ name: 'Native worker' });
    const team = workflows.save({ name: 'Native team', members: [agent.id], lead: agent.id, steps: [] });
    const f = await fixture(
      'work',
      kind === 'brain' ? { kind } : { kind, id: kind === 'agent' ? agent.id : team.id },
      false,
    );
    const queued = f.inbox.accept(f.input('2'))!;
    const other = f.inbox.accept(f.input('3', '456'))!;
    const before = structuredClone(f.inbox.list()[0]);
    await f.remove();
    expect(f.preview()).toMatchObject({ kind: 'work', heldRequests: 1, canFinish: true });
    const body = f.body();
    const result = await f.value.finishRetired(f.instance.id, f.event.id, body);
    const saved = gatewayRetiredInboxHistory(f.instance.id);
    expect(saved[0]).toEqual({
      ...before,
      workKept: { at: result.closedAt, revision: body.revision, throughSequence: 3, serial: 1 },
    });
    expect(saved.find((item) => item.id === queued.id)).toMatchObject({ status: 'needs-review' });
    expect(saved.find((item) => item.id === other.id)).toEqual(other);
    expect(() => f.inbox.finishDispatch(f.event.id, f.work.operationId!, 'Late native answer')).toThrow();
    await f.state.connect();
    expect(() => f.inbox.finishDispatch(f.event.id, f.work.operationId!, 'Late native answer')).toThrow(
      'no longer active',
    );
    await f.state.disconnect();
  },
);

it('closes an uncertain native admission without inventing a dispatch or completion', async () => {
  const f = await fixture('reserved');
  expect(f.preview().native).toBeUndefined();
  await f.value.finishRetired(f.instance.id, f.event.id, f.body());
  const saved = gatewayRetiredInboxHistory(f.instance.id)[0];
  expect(saved.operationId).toBe(f.work.operationId);
  expect(saved.status).toBe('running');
  expect(saved.dispatch).toBeUndefined();
  expect(saved.reply).toBeUndefined();
  expect(saved.workKept).toBeDefined();
});

it.each(['slack', 'discord', 'whatsapp'] as const)(
  'finishes synthetic archived %s receipts without platform availability or credentials',
  async (platform) => {
    const f = await fixture();
    writeJSON(dataPath('gateways-retired', `${f.instance.id}.json`), {
      ...gatewayRetirement(f.instance.id)!,
      platform,
    });
    f.mutate((journal) => {
      const event = journal.events[0];
      event.input.platform = platform;
      if (platform === 'whatsapp') {
        const proof = {
          epoch: '00000000-0000-4000-8000-000000000001',
          sequence: 1,
          id: 'a'.repeat(64),
          confirmed: true,
        };
        event.relay = proof;
        journal.whatsappRelay = {
          epoch: proof.epoch,
          cursor: 1,
          receipt: { ...proof, accepted: 1, ignored: 0, unmatchedSenders: 0 },
        };
      }
    });
    expect(f.preview()).toMatchObject({ canFinish: true, source: { platform } });
    await f.value.finishRetired(f.instance.id, f.event.id, f.body());
    expect(f.preview().closedAt).toEqual(expect.any(Number));
  },
);

it('requires selected-receipt recovery and a fresh revision before closing an interrupted delivery', async () => {
  const f = await fixture();
  f.mutate((journal) => {
    journal.events[0].reply!.parts[1].status = 'sending';
  });
  const before = readJSON<GatewayInboxJournal>(f.file)!;
  const revision = f.preview().revision;
  expect(f.preview()).toMatchObject({ needsPrepare: true, canFinish: false });
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toMatchObject({ status: 409 });
  const recovered = await f.value.prepareRetiredFinish(f.instance.id, f.event.id, { revision });
  expect(recovered).toMatchObject({ needsPrepare: false, canFinish: true });
  expect(recovered.revision).not.toBe(revision);
  expect(gatewayRetiredInboxHistory(f.instance.id)[0].reply?.parts[1].status).toBe('uncertain');
  expect(gatewayRetiredInboxHistory(f.instance.id)[0].dispatch).toEqual(before.events[0].dispatch);
  await expect(f.value.finishRetired(f.instance.id, f.event.id, { ...f.body(), revision })).rejects.toMatchObject({
    status: 409,
  });
  await f.value.finishRetired(f.instance.id, f.event.id, f.body());
});

it('keeps queued requests as evidence rather than claiming native work started or finished', async () => {
  const f = await fixture('work', { kind: 'brain' }, false);
  const queued = f.inbox.accept(f.input('2'))!;
  await f.remove();
  const before = fs.readFileSync(f.file, 'utf8');
  const view = f.preview(queued.id);
  expect(view).toMatchObject({ kind: 'unavailable', canFinish: false, needsPrepare: false });
  await expect(
    f.value.finishRetired(f.instance.id, queued.id, { ...f.body(), revision: view.revision }),
  ).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});

it('finishes notice-only uncertainty and keeps attempted file accounting unchanged', async () => {
  const f = await fixture('delivery', { kind: 'brain' }, false);
  f.mutate((journal) => {
    journal.events[0].reply!.parts.forEach((part, index) => {
      part.status = 'sent';
      part.remoteId = `text-${index}`;
    });
  });
  f.inbox.claimOutgoing();
  f.inbox.settleOutgoing(f.event.id, 0, { status: 'uncertain' });
  const outgoing = structuredClone(f.inbox.list()[0].outgoing);
  await f.remove();
  await f.value.finishRetired(f.instance.id, f.event.id, f.body());
  expect(gatewayRetiredInboxHistory(f.instance.id)[0].outgoing).toEqual(outgoing);
  const notice = await fixture();
  notice.mutate((journal) => {
    const event = journal.events[0];
    event.reply!.parts.forEach((part, index) => {
      part.status = 'sent';
      part.remoteId = `confirmed-${index}`;
    });
    event.outgoing!.forEach((file) => {
      file.status = 'skipped';
    });
  });
  expect(notice.preview().canFinish).toBe(true);
  await notice.value.finishRetired(notice.instance.id, notice.event.id, notice.body());
  expect(notice.preview().closedAt).toEqual(expect.any(Number));
});

it('rejects pending retirement, active IDs, missing receipts, stale revisions and extra or missing acknowledgements', async () => {
  const active = await fixture('delivery', { kind: 'brain' }, false);
  expect(() => active.preview()).toThrow('No such removed');
  retireGatewayInstance(active.instance.id);
  expect(active.preview().canFinish).toBe(false);
  await expect(active.value.finishRetired(active.instance.id, active.event.id, active.body())).rejects.toMatchObject({
    status: 409,
  });
  await active.state.disconnect();
  await active.value.removeInstance(active.instance.id);
  const before = fs.readFileSync(active.file, 'utf8');
  const body = active.body();
  for (const value of [
    {},
    { ...body, revision: '0'.repeat(64) },
    { ...body, acknowledgeNoSend: false },
    { ...body, acknowledgeMayStillRun: false },
    { ...body, action: 'retry' },
    { ...body, remoteId: 'invented' },
  ])
    await expect(active.value.finishRetired(active.instance.id, active.event.id, value)).rejects.toMatchObject({
      status: 409,
    });
  expect(fs.readFileSync(active.file, 'utf8')).toBe(before);
  expect(() => active.preview('missing')).toThrow('No such saved');
});

it.each(['account', 'state'] as const)('refuses %s ownership conflicts without changing receipts', async (kind) => {
  const f = await fixture();
  const release = await (kind === 'account'
    ? ownership.claimGatewayAccount(f.instance.platform, f.instance.accountId)
    : ownership.claimGatewayState(f.instance.id));
  closes.push(release);
  const before = fs.readFileSync(f.file, 'utf8');
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toMatchObject({ status: 503 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  await release();
  await f.value.finishRetired(f.instance.id, f.event.id, f.body());
});

it('uses no SDK state or credentials and never reopens unrelated saved Outbox delivery', async () => {
  const f = await fixture();
  const outbox = dataPath('gateways-runtime', f.instance.id, 'outbox.json');
  fs.writeFileSync(outbox, 'opaque saved Outbox evidence');
  fs.writeFileSync(f.sdk, 'unreadable SDK bytes');
  const secrets = dataPath('gateway-secrets.json');
  const oldSecrets = fs.existsSync(secrets) ? fs.readFileSync(secrets, 'utf8') : '{}';
  fs.writeFileSync(secrets, '{unreadable credentials');
  try {
    await f.value.finishRetired(f.instance.id, f.event.id, f.body());
    expect(fs.readFileSync(f.sdk, 'utf8')).toBe('unreadable SDK bytes');
    expect(fs.readFileSync(outbox, 'utf8')).toBe('opaque saved Outbox evidence');
    expect(fs.readFileSync(secrets, 'utf8')).toBe('{unreadable credentials');
  } finally {
    fs.writeFileSync(secrets, oldSecrets);
  }
});

it('rechecks retirement after asynchronous ownership acquisition and refuses a changed identity', async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.file, 'utf8');
  const claim = ownership.claimGatewayState;
  vi.spyOn(ownership, 'claimGatewayState').mockImplementation(async (id) => {
    const release = await claim(id);
    writeJSON(dataPath('gateways-retired', `${id}.json`), { ...gatewayRetirement(id)!, name: 'Changed during claim' });
    return release;
  });
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});

it('keeps closures atomic on write failure and refuses corrupt or cross-instance evidence', async () => {
  const f = await fixture();
  const before = fs.readFileSync(f.file, 'utf8');
  const write = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file).split(path.sep).join('/').includes('/inbox.json.')) throw new Error('PRIVATE_DISK_PATH');
    return write(file, ...args);
  });
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toThrow(
    'Local finish could not be saved',
  );
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  vi.restoreAllMocks();
  f.mutate((journal) => {
    journal.events[0].input.accountId = 'other-account';
  });
  expect(() => f.preview()).toThrow('could not be reviewed safely');
  fs.writeFileSync(f.file, before);
  f.mutate((journal) => {
    journal.events[0].input.platform = 'discord';
  });
  expect(f.preview().canFinish).toBe(false);
  await expect(f.value.finishRetired(f.instance.id, f.event.id, f.body())).rejects.toMatchObject({ status: 409 });
});
