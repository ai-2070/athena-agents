import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayOutboxJournal } from '../../shared/types.ts';
import { activeProject, outbox, setActiveProject, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import { saveGatewayInstance, saveGatewayCredentials, retireGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayRetirement } from '../../server/gateways/retirement.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import {
  GatewayOutboxLedger,
  gatewayOutboxReviewRevision,
  readGatewayOutboxDeliveries,
} from '../../server/gateways/outbox.ts';
import { projectGatewayPost, readGatewayPostDelivery } from '../../server/gateways/outbox-posts.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import * as ownership from '../../server/gateways/ownership.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 196000;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture(platform: 'telegram' | 'discord' = 'telegram', interrupted = false, retire = true) {
  const project = activeProject();
  const config = {
    ...gatewayConfig(String(account++)),
    projectId: project.id,
    platform,
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
    senderPolicy: { platform, allowedUserIds: ['123'] },
  };
  const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_TEST_TOKEN' });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const event = inbox.accept({ ...gatewayInput(), platform, accountId: instance.accountId })!;
  const work = inbox.claimNext()!;
  inbox.beginDispatch(event.id, work.operationId!, await gatewayConversation(work, new AbortController().signal));
  inbox.finishDispatch(event.id, work.operationId!, 'Native answer stays separate');
  inbox.claimReply();
  inbox.settleReply(event.id, 0, { remoteId: 'native-id' });
  const ledger = new GatewayOutboxLedger(state, inbox);
  const postId = `post-${account}`;
  const parts = ['Confirmed prefix', 'Uncertain approved part', 'Pending approved tail'];
  const add = (id: string) => {
    const approved = ledger.approve(
      ledger.prepare({ instanceId: instance.id, projectId: project.id, postId: id, eventId: event.id, parts }).approval,
    );
    outbox.save({
      id,
      platform,
      status: 'posting',
      parts,
      gateway: { instanceId: instance.id, eventId: event.id },
      gatewayApprovedRevision: approved.revision,
    });
  };
  add(postId);
  let claim = ledger.claim()!;
  ledger.settle(claim, { remoteId: 'confirmed-prefix' });
  claim = ledger.claim()!;
  if (!interrupted) ledger.settle(claim, { status: 'uncertain' });
  add(`${postId}-peer`);
  const file = state.outboxFile();
  const inboxFile = state.inboxFile();
  const sdkFile = dataPath('gateways-runtime', instance.id, 'sdk-state.json');
  const value = new GatewaySupervisor(() => {
    throw new Error('Must not start a transport');
  });
  closes.push(() => value.stop());
  const remove = async () => {
    await state.disconnect();
    await value.removeInstance(instance.id);
  };
  if (retire) await remove();
  const view = () => readGatewayPostDelivery(postId);
  const body = () => ({ revision: view().revision, acknowledgeNoSend: true });
  const prepare = () => value.prepareRetiredOutbox(instance.id, project.id, postId, { revision: view().revision });
  const finish = (input: unknown = body()) => value.finishRetiredOutbox(instance.id, project.id, postId, input);
  const mutate = (change: (journal: GatewayOutboxJournal) => void) => {
    const journal = readJSON<GatewayOutboxJournal>(file)!;
    change(journal);
    writeJSON(file, journal);
  };
  return {
    instance,
    project,
    config,
    state,
    inbox,
    ledger,
    postId,
    claim,
    file,
    inboxFile,
    sdkFile,
    value,
    view,
    body,
    prepare,
    finish,
    mutate,
    remove,
  };
}

it.each(['telegram', 'discord'] as const)(
  'closes retired %s Outbox delivery while keeping approval, recipient, part evidence and peers unchanged',
  async (platform) => {
    const f = await fixture(platform);
    const before = readGatewayOutboxDeliveries(f.instance.id);
    const native = fs.readFileSync(f.inboxFile, 'utf8');
    const sdk = fs.readFileSync(f.sdkFile, 'utf8');
    const publicPost = outbox.get(f.postId)!;
    const release = await ownership.claimGatewayState(f.instance.id);
    closes.push(release);
    const bytes = fs.readFileSync(f.file, 'utf8');
    expect(f.view()).toMatchObject({ removed: true, paused: false, canFinish: true, canRetry: false });
    expect(f.view().parts.every((part) => !part.canConfirm)).toBe(true);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
    await release();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await f.finish();
    const after = readGatewayOutboxDeliveries(f.instance.id);
    expect(after[0]).toEqual({
      ...before[0],
      closed: { at: expect.any(Number), revision: gatewayOutboxReviewRevision(before[0]) },
    });
    expect(after[1]).toEqual(before[1]);
    expect(f.view()).toMatchObject({ removed: true, canFinish: false, canRetry: false, closedAt: expect.any(Number) });
    expect(projectGatewayPost(publicPost)).toMatchObject({
      status: 'rejected',
      error: null,
      gatewayProgress: { state: 'closed' },
    });
    expect(outbox.get(f.postId)).toEqual(publicPost);
    expect(fs.readFileSync(f.inboxFile, 'utf8')).toBe(native);
    expect(fs.readFileSync(f.sdkFile, 'utf8')).toBe(sdk);
    expect(fetch).not.toHaveBeenCalled();
    await f.state.connect();
    expect(() => f.ledger.settle(f.claim, { remoteId: 'late-result' })).toThrow('no longer owns');
    expect(() => f.ledger.authorize(f.claim, f.claim.event, f.claim.text)).toThrow();
  },
);

it('recovers only the selected interrupted post under a fresh removal-and-receipt revision', async () => {
  const f = await fixture('telegram', true);
  const before = readGatewayOutboxDeliveries(f.instance.id);
  const revision = f.view().revision;
  expect(f.view()).toMatchObject({ needsPrepare: true, canFinish: false });
  await expect(f.finish()).rejects.toMatchObject({ status: 409 });
  await f.prepare();
  const after = readGatewayOutboxDeliveries(f.instance.id);
  expect(after[0].receipts[1]).toEqual({ ...before[0].receipts[1], status: 'uncertain' });
  expect(after[1]).toEqual(before[1]);
  expect(f.view().revision).not.toBe(revision);
  await expect(f.finish({ revision, acknowledgeNoSend: true })).rejects.toMatchObject({ status: 409 });
  await f.finish();
});

it('refuses pending or missing removal records, stale bodies and any retry or confirmation authority', async () => {
  const f = await fixture('telegram', false, false);
  retireGatewayInstance(f.instance.id);
  expect(f.view().canFinish).toBe(false);
  await expect(f.finish()).rejects.toMatchObject({ status: 409 });
  await f.remove();
  const before = fs.readFileSync(f.file, 'utf8');
  const body = f.body();
  for (const input of [
    {},
    { ...body, revision: '0'.repeat(64) },
    { ...body, acknowledgeNoSend: false },
    { ...body, action: 'retry' },
    { ...body, remoteId: 'invented-id' },
    { ...body, projectId: 'another-project' },
  ])
    await expect(f.finish(input)).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  await expect(
    f.value.reviewOutbox(f.instance.id, f.project.id, f.postId, {
      action: 'confirm',
      revision: body.revision,
      index: 1,
      remoteId: 'invented',
      acknowledgeChecked: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  const location = dataPath('gateways-retired', `${f.instance.id}.json`);
  const record = fs.readFileSync(location, 'utf8');
  fs.unlinkSync(location);
  try {
    expect(f.view()).toMatchObject({ removed: true, canFinish: false, needsPrepare: false });
    await expect(f.finish()).rejects.toMatchObject({ status: 404 });
  } finally {
    fs.writeFileSync(location, record);
  }
});

it.each(['account', 'state'] as const)(
  'keeps private receipts unchanged when %s ownership is unavailable',
  async (kind) => {
    const f = await fixture();
    const before = fs.readFileSync(f.file, 'utf8');
    const release = await (kind === 'account'
      ? ownership.claimGatewayAccount(f.instance.platform, f.instance.accountId)
      : ownership.claimGatewayState(f.instance.id));
    closes.push(release);
    await expect(f.finish()).rejects.toMatchObject({ status: 503 });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    await release();
    await f.finish();
  },
);

it('pins the original project across an asynchronous project switch and refuses another project with the same post ID', async () => {
  const f = await fixture();
  const body = f.body();
  const other = await createProject({ name: 'Other Outbox project' });
  withProject(other, () =>
    outbox.save({ id: f.postId, platform: 'telegram', status: 'pending', parts: ['Unrelated draft'] }),
  );
  await expect(withProject(other, () => f.finish(body))).rejects.toMatchObject({ status: 409 });
  const claim = ownership.claimGatewayState;
  vi.spyOn(ownership, 'claimGatewayState').mockImplementation(async (id) => {
    const release = await claim(id);
    setActiveProject(other.id);
    return release;
  });
  try {
    await withProject(f.project, () => f.finish(body));
    expect(withProject(other, () => outbox.get(f.postId)?.parts)).toEqual(['Unrelated draft']);
  } finally {
    setActiveProject(f.project.id);
  }
});

it('rechecks public post text and retirement identity after asynchronous claims', async () => {
  const f = await fixture();
  const body = f.body();
  const before = fs.readFileSync(f.file, 'utf8');
  const claim = ownership.claimGatewayState;
  vi.spyOn(ownership, 'claimGatewayState').mockImplementation(async (id) => {
    const release = await claim(id);
    outbox.save({ ...outbox.get(f.postId)!, parts: ['Changed while claiming'] });
    return release;
  });
  await expect(f.finish(body)).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  vi.restoreAllMocks();
  outbox.save({ ...outbox.get(f.postId)!, parts: readGatewayOutboxDeliveries(f.instance.id)[0].parts });
  const second = ownership.claimGatewayState;
  vi.spyOn(ownership, 'claimGatewayState').mockImplementation(async (id) => {
    const release = await second(id);
    writeJSON(dataPath('gateways-retired', `${id}.json`), { ...gatewayRetirement(id)!, name: 'Changed during claim' });
    return release;
  });
  await expect(f.finish()).rejects.toMatchObject({ status: 409 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
});

it('keeps held confirmation history and a permanent closure seal across restart', async () => {
  const f = await fixture('telegram', false, false);
  saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
  f.ledger.review(f.project.id, f.postId, {
    action: 'confirm',
    revision: gatewayOutboxReviewRevision(f.ledger.list()[0]),
    index: 1,
    remoteId: 'manually-checked',
    acknowledgeChecked: true,
  });
  await f.remove();
  const before = readGatewayOutboxDeliveries(f.instance.id)[0];
  expect(before.reviewHeld).toBe(true);
  await f.finish();
  expect(readGatewayOutboxDeliveries(f.instance.id)[0]).toMatchObject({
    ...before,
    closed: { revision: gatewayOutboxReviewRevision(before) },
  });
  const restarted = new GatewaySupervisor(() => {
    throw new Error('No transport');
  });
  closes.push(() => restarted.stop());
  await expect(restarted.finishRetiredOutbox(f.instance.id, f.project.id, f.postId, f.body())).rejects.toMatchObject({
    status: 409,
  });
  f.mutate((journal) => {
    journal.deliveries[0].receipts[2].attempts = 1;
  });
  expect(() => readGatewayOutboxDeliveries(f.instance.id)).toThrow('unreadable');
});

it('opens no native inbox, SDK state or credential store when closing saved Outbox evidence', async () => {
  const f = await fixture();
  fs.writeFileSync(f.inboxFile, 'opaque broken native inbox');
  fs.writeFileSync(f.sdkFile, 'opaque broken SDK state');
  const secrets = dataPath('gateway-secrets.json');
  const original = fs.readFileSync(secrets, 'utf8');
  fs.writeFileSync(secrets, '{broken credentials');
  try {
    await f.finish();
    expect(fs.readFileSync(f.inboxFile, 'utf8')).toBe('opaque broken native inbox');
    expect(fs.readFileSync(f.sdkFile, 'utf8')).toBe('opaque broken SDK state');
    expect(fs.readFileSync(secrets, 'utf8')).toBe('{broken credentials');
  } finally {
    fs.writeFileSync(secrets, original);
  }
});

it('does not persist partial recovery or closure after a failed atomic write', async () => {
  const f = await fixture('telegram', true);
  const before = fs.readFileSync(f.file, 'utf8');
  const original = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file).split(path.sep).join('/').includes('/outbox.json.')) throw new Error('PRIVATE_DISK_PATH');
    return original(file, ...args);
  });
  await expect(f.prepare()).rejects.toThrow('Saved receipts could not be finished safely');
  expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  vi.restoreAllMocks();
  await f.prepare();
  const recovered = fs.readFileSync(f.file, 'utf8');
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file).split(path.sep).join('/').includes('/outbox.json.')) throw new Error('PRIVATE_DISK_PATH');
    return original(file, ...args);
  });
  await expect(f.finish()).rejects.toMatchObject({ status: 503 });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(recovered);
});
