import fs from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { activeProject, emit, listProjects, saveProjects } from '../../server/store.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { listGatewayInstances, removeGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = [];
beforeEach(() => { for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

it('summarizes review counts without exposing messages or credentials and refreshes after journal changes', async () => {
  const config = gatewayConfig('98000'); const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_BOT_TOKEN' });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const first = inbox.accept({ ...gatewayInput(), accountId: instance.accountId, text: 'PRIVATE_MESSAGE_BODY' })!;
  const second = inbox.accept({ ...gatewayInput('2', '456'), accountId: instance.accountId })!;
  inbox.review(first.id); saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await supervisor.start();
  const project = activeProject();
  expect(supervisor.summary()).toEqual([{ id: instance.id, name: instance.name, platform: 'telegram', projectId: project.id, projectName: project.name, enabled: false, status: 'paused', reviewCount: 1 }]);
  const safe = JSON.stringify(supervisor.summary());
  expect(safe).not.toContain('PRIVATE_BOT_TOKEN'); expect(safe).not.toContain('PRIVATE_MESSAGE_BODY');
  expect(safe).not.toContain('allowedUserIds'); expect(safe).not.toContain('conversationId');
  inbox.review(second.id); expect(supervisor.summary()[0].reviewCount).toBe(2);
  expect(activeProject().id).toBe(project.id);
  removeGatewayInstance(instance.id); expect(supervisor.summary()).toEqual([]);
});

it('reports an unreadable inbox as unknown without resetting it or breaking unrelated instances', async () => {
  const bad = saveGatewayInstance({ ...gatewayConfig('98001'), enabled: false });
  const good = saveGatewayInstance({ ...gatewayConfig('98002'), enabled: false });
  const state = new GatewayStateAdapter(bad.id); await state.connect(); closes.push(() => state.disconnect());
  const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await supervisor.start();
  expect(supervisor.summary().find((item) => item.id === bad.id)?.reviewCount).toBe(0);
  fs.writeFileSync(state.inboxFile(), '{broken'); emit('gateway-inbox', { instanceId: bad.id });
  const summaries = supervisor.summary();
  expect(summaries.find((item) => item.id === bad.id)?.reviewCount).toBeNull();
  expect(summaries.find((item) => item.id === good.id)?.reviewCount).toBe(0);
  expect(fs.readFileSync(state.inboxFile(), 'utf8')).toBe('{broken');
});

it('reports a deleted bound project as unavailable without changing the open project', () => {
  const current = activeProject(); const other = { ...current, id: 'gateway-status-project', name: 'Other project' };
  saveProjects([...listProjects(), other]);
  const instance = saveGatewayInstance({ ...gatewayConfig('98003'), projectId: other.id });
  const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
  expect(supervisor.summary().find((item) => item.id === instance.id)?.projectName).toBe('Other project');
  saveProjects(listProjects().filter((project) => project.id !== other.id));
  expect(supervisor.summary().find((item) => item.id === instance.id)).toMatchObject({ projectName: 'Project unavailable', status: 'needs-setup' });
  expect(activeProject().id).toBe(current.id);
});
