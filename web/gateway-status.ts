import type { GatewayStatus } from '../shared/types.ts';
import type { DotTone } from './ui/classes.ts';

const stateLabel: Record<GatewayStatus['status'], string> = {
  paused: 'paused',
  connecting: 'connecting',
  connected: 'connected',
  'needs-setup': 'needs setup',
  retrying: 'retrying',
};
const needsInbox = (item: GatewayStatus) =>
  item.reviewCount === null || item.reviewCount > 0 || item.status === 'connected' || item.platform !== 'telegram';
export function gatewayStatusHref(item: GatewayStatus): string {
  return `#/settings?tab=gateways&${needsInbox(item) ? 'inbox' : 'instance'}=${encodeURIComponent(item.id)}`;
}
const priority = (item: GatewayStatus) =>
  item.reviewCount === null || item.reviewCount > 0
    ? 0
    : item.status === 'needs-setup' || item.status === 'retrying'
      ? 1
      : item.status === 'connecting'
        ? 2
        : item.status === 'connected'
          ? 3
          : 4;

/** Keep the sidebar bounded and put instances needing attention first. */
export function gatewayStatusLinks(items: GatewayStatus[]) {
  return [...items]
    .sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((item) => {
      const value =
        item.reviewCount === null
          ? 'check inbox'
          : item.reviewCount > 0
            ? `${item.reviewCount} need review`
            : stateLabel[item.status];
      const dot: DotTone =
        item.reviewCount === null || item.reviewCount > 0 || item.status === 'needs-setup' || item.status === 'retrying'
          ? 'warn'
          : item.status === 'connected'
            ? 'on'
            : item.status === 'connecting'
              ? 'busy'
              : 'off';
      const platform = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' }[
        item.platform
      ];
      return {
        id: item.id,
        label: `${item.name} · ${item.projectName}`,
        value,
        dot,
        href: gatewayStatusHref(item),
        title: `${item.name} · ${platform} · ${item.projectName} · ${stateLabel[item.status]}${item.reviewCount === null ? ' · inbox unreadable' : item.reviewCount > 0 ? ` · ${item.reviewCount} messages need review` : ''}`,
      };
    });
}
