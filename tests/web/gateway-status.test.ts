import { expect, it } from 'vitest';
import { gatewayStatusHref, gatewayStatusLinks } from '../../web/gateway-status.ts';
import type { GatewayStatus } from '../../shared/types.ts';
const status = (id: string, patch: Partial<GatewayStatus> = {}): GatewayStatus => ({ id, name: id, platform: 'telegram', projectId: 'p1', projectName: 'Project one', enabled: true, status: 'connected', reviewCount: 0, ...patch });

it('links each instance to its inbox for review and to its own editor for setup', () => {
  expect(gatewayStatusHref(status('first', { status: 'needs-setup' }))).toBe('#/settings?tab=gateways&instance=first');
  expect(gatewayStatusHref(status('second', { reviewCount: 2 }))).toBe('#/settings?tab=gateways&inbox=second');
  expect(gatewayStatusHref(status('third', { enabled: false, status: 'paused', reviewCount: 1 }))).toContain('inbox=third');
  expect(gatewayStatusHref(status('fourth', { status: 'retrying' }))).toContain('instance=fourth');
  expect(gatewayStatusHref(status('id with &', { status: 'paused' }))).toContain('instance=id%20with%20%26');
});

it('puts attention first, bounds the sidebar, and identifies project and platform without mixing instances', () => {
  const items = [status('Healthy'), status('Paused', { status: 'paused' }), status('Review', { reviewCount: 3, projectName: 'Other project' }), status('Setup', { status: 'needs-setup' }), status('Retrying', { status: 'retrying' }), status('Connecting', { status: 'connecting' })];
  const links = gatewayStatusLinks(items);
  expect(links).toHaveLength(5); expect(links[0]).toMatchObject({ id: 'Review', value: '3 need review', dot: 'warn' });
  expect(links[0].title).toContain('Other project'); expect(links[0].title).toContain('Telegram');
  expect(links[0].label).toBe('Review · Other project');
  expect(links.some((item) => item.id === 'Paused')).toBe(false);
  expect(items[0].id).toBe('Healthy');
});

it('shows unreadable inboxes and unsupported platforms without claiming they are healthy', () => {
  expect(gatewayStatusLinks([status('Bad', { reviewCount: null })])[0]).toMatchObject({ dot: 'warn', value: 'check inbox', href: '#/settings?tab=gateways&inbox=Bad' });
  const unsupported = status('Slack', { platform: 'slack', status: 'needs-setup' });
  expect(gatewayStatusLinks([unsupported])[0]).toMatchObject({ dot: 'warn', value: 'needs setup', href: '#/settings?tab=gateways&inbox=Slack' });
});
