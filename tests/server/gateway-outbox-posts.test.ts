import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayOutboxJournal } from '../../shared/types.ts';
import { activeProject, outbox, runs, setActiveProject, setSecret, withProject, workflows } from '../../server/store.ts';
import { startWorkflow } from '../../server/workflows.ts';
import { createProject } from '../../server/projects.ts';
import * as social from '../../server/social.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { removeGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayOutboxLedger, gatewayOutboxProtectedBindings, gatewayOutboxReviewRevision } from '../../server/gateways/outbox.ts';
import { gatewayOutboxDestinations, registerGatewayOutbox } from '../../server/gateways/outbox-owner.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import type { GatewayReplySender } from '../../server/gateways/replies.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import { toolsForAgent } from '../../server/tools.ts';

const closes: (() => Promise<void> | void)[] = []; let accounts = 9560000000;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const project = activeProject(); const config = { ...gatewayConfig(String(accounts++)), projectId: project.id }; const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_TOKEN' }); const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state); const input = { ...gatewayInput(), accountId: instance.accountId }; const source = inbox.accept(input)!; const claim = inbox.claimNext()!;
  inbox.beginDispatch(source.id, claim.operationId!, await gatewayConversation(claim, new AbortController().signal)); inbox.finishDispatch(source.id, claim.operationId!, 'Private native answer'); inbox.claimReply(); inbox.settleReply(source.id, 0, { remoteId: 'confirmed-native' });
  const ledger = new GatewayOutboxLedger(state, inbox); const abort = new AbortController(); closes.push(registerGatewayOutbox(instance.id, ledger, abort.signal));
  const gateway = { instanceId: instance.id, eventId: source.id };
  const draft = () => social.draftPost({ platform: 'telegram', text: 'Approved exact text 😀', gateway });
  const review = (id: string, parts?: string[]) => { const item = social.listPosts().find((item) => item.id === id)!; return social.prepareGatewayPost(id, { gateway, parts: parts ?? item.parts, draftRevision: item.gatewayDraftRevision }); };
  const approve = (id: string) => { const preview = review(id); return social.approvePost(id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision }); };
  return { project, config, instance, state, inbox, source, input, ledger, abort, gateway, draft, review, approve };
}

describe('Outbox gateway approvals and progress', () => {
  it('saves unaddressed drafts for a human recipient choice and never uses old global secrets', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setSecret('telegramBotToken', 'OLD_PRIVATE_TOKEN'); setSecret('discordWebhook', 'https://PRIVATE_WEBHOOK.invalid');
    const item = await social.draftPost({ platform: 'telegram', text: 'Draft only' }); expect(item.gateway).toBeUndefined(); expect(item.status).toBe('pending');
    await expect(social.approvePost(item.id)).rejects.toThrow('Review'); await expect(social.sendTelegram('Text')).rejects.toThrow('explicit gateway'); await expect(social.sendDiscord('Text')).rejects.toThrow('explicit gateway'); expect(fetch).not.toHaveBeenCalled();
    const agent = { id: 'notifier', name: 'Notifier', toolGroups: ['social'] }; const tools = toolsForAgent(agent);
    expect(tools.find((tool) => tool.name === 'telegram_send')!.risk).toBe('high'); expect(tools.find((tool) => tool.name === 'discord_send')!.risk).toBe('high');
    await expect(tools.find((tool) => tool.name === 'notify_user')!.run({ text: 'External', telegram: true }, { agent })).rejects.toThrow('gateway_draft'); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps workflow notifications local and saves optional Telegram messages as unapproved drafts', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setSecret('telegramBotToken', 'OLD_PRIVATE_TOKEN');
    const wf = workflows.save({ name: 'Notify and draft', steps: [{ id: 'notify', type: 'notify', text: 'Report: {{input}}', telegram: true }] });
    const run = await startWorkflow(wf.id, 'ready'); await expect.poll(() => runs.get(run.id)?.status).toBe('done');
    const draft = outbox.list().find((post) => post.parts[0] === 'Report: ready')!; expect(draft).toMatchObject({ platform: 'telegram', status: 'pending' }); expect(draft.gateway).toBeUndefined();
    expect(runs.get(run.id)?.steps[0].output).toContain('choose its recipient and approve'); expect(fetch).not.toHaveBeenCalled();
  });

  it('lists only current-project completed destinations owned by a live worker, without message text or credentials', async () => {
    const f = await fixture(); const list = gatewayOutboxDestinations(f.project.id); expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ ...f.gateway, recipient: { conversationId: '123', sourceMessageId: '1' } });
    expect(JSON.stringify(list)).not.toMatch(/PRIVATE_TOKEN|Private native answer|Message 1/); expect(gatewayOutboxDestinations('another-project')).toEqual([]);
    f.abort.abort(); expect(gatewayOutboxDestinations(f.project.id)).toEqual([]); expect(() => f.review('missing')).toThrow();
  });

  it('saves the exact selected recipient and Unicode-safe parts before returning the approval preview', async () => {
    const f = await fixture(); const item = await f.draft(); const text = 'x'.repeat(2999) + '😀rest'; const preview = f.review(item.id, [text]);
    expect(preview.approval.parts.join('')).toBe(text); expect(preview.approval.parts[0]).toHaveLength(2999); expect(preview.approval.parts[1]).toBe('😀rest');
    expect(outbox.get(item.id)).toMatchObject({ gateway: f.gateway, parts: preview.approval.parts, status: 'pending' }); expect(f.ledger.list()).toEqual([]);
    await social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision }); expect(f.ledger.list()[0].parts).toEqual(preview.approval.parts);
  });

  it('requires a fresh draft snapshot and cannot approve changed text, another platform, project or source', async () => {
    const f = await fixture(); const item = await f.draft(); const preview = f.review(item.id);
    social.editPost(item.id, { parts: ['New draft'], gateway: f.gateway, draftRevision: preview.draftRevision });
    await expect(social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision })).rejects.toThrow('Review');
    const current = f.review(item.id); await expect(social.approvePost(item.id, { gatewayApproval: { ...current.approval, parts: ['Unreviewed'] }, draftRevision: current.draftRevision })).rejects.toThrow('Review');
    await expect(social.draftPost({ platform: 'discord', text: 'Wrong instance', gateway: f.gateway })).rejects.toThrow('platform');
    const other = await createProject({ name: 'Other gateway project' }); await withProject(other, async () => { expect(gatewayOutboxDestinations(other.id)).toEqual([]); await expect(social.draftPost({ platform: 'telegram', text: 'Wrong project', gateway: f.gateway })).rejects.toThrow('this project'); });
    f.inbox.accept({ ...f.input, kind: 'edit', sourceEventId: 'edit', text: 'Changed source' }); await withProject(f.project, async () => { await expect(social.approvePost(item.id, { gatewayApproval: current.approval, draftRevision: current.draftRevision })).rejects.toThrow('completed'); }); expect(f.ledger.list()).toEqual([]);
  });

  it('projects per-part results from private receipts and blocks edits, rejection, return and removal after approval', async () => {
    const f = await fixture(); const item = await f.draft(); await f.approve(item.id);
    const claim = f.ledger.claim()!; f.ledger.settle(claim, { status: 'uncertain' }); const projected = social.listPosts().find((post) => post.id === item.id)!;
    expect(projected).toMatchObject({ status: 'failed', gatewayProgress: { state: 'uncertain', parts: [{ status: 'uncertain', attempts: 1 }], recipient: { conversationId: '123' } } });
    expect(JSON.stringify(projected)).not.toMatch(/configHash|sourceHash|PRIVATE_TOKEN|Private native answer/);
    expect(() => social.editPost(item.id, { parts: ['Replace'] })).toThrow('already approved'); expect(() => social.rejectPost(item.id)).toThrow('already approved'); expect(() => social.removePost(item.id)).toThrow('already approved');
    const send = vi.fn(); await expect(social.returnPost(item.id, 'Return', send)).rejects.toThrow('already approved'); expect(send).not.toHaveBeenCalled(); expect(f.ledger.list()[0].receipts[0].status).toBe('uncertain');
  });

  it('delivers only through the explicitly chosen owner and reports queued separately from sent', async () => {
    const first = await fixture(); const second = await fixture(); const item = await second.draft(); expect((await second.approve(item.id)).gatewayProgress?.state).toBe('queued'); expect(first.ledger.list()).toEqual([]);
    const send = vi.fn<GatewayReplySender>(async () => 'confirmed-post');
    const service = new GatewayReplies(second.inbox, send, second.abort.signal, () => true, undefined, second.ledger); closes.push(() => service.stop()); await service.wake();
    expect(send).toHaveBeenCalledTimes(1); expect(social.listPosts().find((post) => post.id === item.id)).toMatchObject({ status: 'posted', postIds: ['confirmed-post'], gatewayProgress: { state: 'sent' } });
  });

  it('pins approved tool sends to their starting project and stops aborted sends before saving a draft', async () => {
    const f = await fixture(); const other = await createProject({ name: 'Switched project' });
    await withProject(f.project, async () => {
      const sending = social.sendTelegram('Explicit approved tool text', f.gateway); setActiveProject(other.id);
      expect(await sending).toContain('Approved and queued'); expect(f.ledger.list()[0]).toMatchObject({ projectId: f.project.id, parts: ['Explicit approved tool text'] });
      const before = outbox.list().length; const abort = new AbortController(); abort.abort();
      await expect(social.sendTelegram('Never saved', f.gateway, {}, abort.signal)).rejects.toThrow(); expect(outbox.list()).toHaveLength(before);
    });
    expect(withProject(other, () => outbox.list())).toEqual([]);
  });

  it('keeps authoritative private approval if the public projection save fails, without allowing another recipient or blind resend', async () => {
    const f = await fixture(); const item = await f.draft(); const preview = f.review(item.id); const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (/[\\/]outbox[\\/]/.test(String(file))) throw new Error('PUBLIC_SAVE_FAILED'); return write(file, ...args); });
    await expect(social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision })).rejects.toThrow(); vi.restoreAllMocks();
    expect(outbox.get(item.id)!.status).toBe('pending'); expect(social.listPosts().find((post) => post.id === item.id)?.gatewayProgress?.state).toBe('queued');
    expect(() => social.editPost(item.id, { parts: ['Changed'] })).toThrow('already approved'); expect(f.ledger.list()).toHaveLength(1);
  });

  it('locks missing or corrupt committed receipts instead of turning the approved post into an editable draft', async () => {
    const f = await fixture(); const item = await f.draft(); const preview = f.review(item.id); await social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision }); const path = f.state.outboxFile(); const original = fs.readFileSync(path, 'utf8'); fs.unlinkSync(path);
    const missing = social.listPosts().find((post) => post.id === item.id)!; expect(missing.gatewayProgress?.state).toBe('unavailable');
    await expect(social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: missing.gatewayDraftRevision })).rejects.toThrow('missing');
    expect(() => social.removePost(item.id)).toThrow('already approved'); fs.writeFileSync(path, '{broken'); expect(social.listPosts().find((post) => post.id === item.id)?.gatewayProgress?.state).toBe('unavailable'); expect(() => social.rejectPost(item.id)).toThrow(); fs.writeFileSync(path, original);
  });

  it('finishes locally only under a paused exclusive owner and retains uncertainty, confirmed IDs and audit receipts', async () => {
    const f = await fixture(); const item = await f.draft(); const preview = f.review(item.id, ['First', 'Second']); await social.approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision });
    let claim = f.ledger.claim()!; f.ledger.settle(claim, { remoteId: 'confirmed-prefix' }); claim = f.ledger.claim()!; f.ledger.settle(claim, { status: 'uncertain' }); const before = f.ledger.list()[0]; const revision = gatewayOutboxReviewRevision(before);
    expect(() => f.ledger.finishLocal(f.project.id, item.id, { revision, acknowledgeNoSend: true })).toThrow('Pause'); saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await expect(supervisor.finishOutbox(f.instance.id, f.project.id, item.id, { revision, acknowledgeNoSend: true })).rejects.toMatchObject({ status: 503 });
    await f.state.disconnect(); await supervisor.finishOutbox(f.instance.id, f.project.id, item.id, { revision, acknowledgeNoSend: true }); await f.state.connect();
    expect(f.ledger.list()[0]).toMatchObject({ ...before, closed: { revision, at: expect.any(Number) } }); expect(gatewayOutboxProtectedBindings(f.instance.id).size).toBe(0);
    expect(social.listPosts().find((post) => post.id === item.id)).toMatchObject({ status: 'rejected', gatewayProgress: { state: 'closed', parts: [{ remoteId: 'confirmed-prefix' }, { status: 'uncertain' }] } });
    saveGatewayInstance(f.config, f.instance.id); expect(f.ledger.claim()).toBeNull(); expect(() => f.ledger.authorize(claim, claim.event, claim.text)).toThrow();
    const saved = JSON.parse(fs.readFileSync(f.state.outboxFile(), 'utf8')) as GatewayOutboxJournal; saved.deliveries[0].receipts[1].status = 'failed'; fs.writeFileSync(f.state.outboxFile(), JSON.stringify(saved)); expect(() => f.ledger.list()).toThrow('unreadable');
  });

  it('allows local review from the original project after rebinding and retains removed-instance receipts as held', async () => {
    const f = await fixture(); const item = await f.draft(); await f.approve(item.id); const other = await createProject({ name: 'New instance destination' });
    saveGatewayInstance({ ...f.config, enabled: false, projectId: other.id }, f.instance.id); await f.state.disconnect();
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await withProject(f.project, async () => {
      const before = social.listPosts().find((post) => post.id === item.id)!;
      await supervisor.finishOutbox(f.instance.id, f.project.id, item.id, { revision: before.gatewayProgress!.reviewRevision, acknowledgeNoSend: true });
      expect(social.listPosts().find((post) => post.id === item.id)?.gatewayProgress?.state).toBe('closed');
    });
    expect(withProject(other, () => social.listPosts())).toEqual([]);
    const removed = await fixture(); const post = await removed.draft(); await removed.approve(post.id); removeGatewayInstance(removed.instance.id);
    const saved = social.listPosts().find((entry) => entry.id === post.id)!; expect(saved).toMatchObject({ status: 'failed', gatewayProgress: { state: 'held' } }); expect(saved.error).toContain('removed'); expect(saved.gatewayProgress?.reviewRevision).toBeUndefined();
    expect(() => social.editPost(post.id, { parts: ['Replace'] })).toThrow('already approved');
  });
});
