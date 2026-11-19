// The sidebar's Chat gateways lines: one per bot, the ones needing you first, at most five.
import type { GatewayStatus } from '../shared/types.ts';
import type { DotTone } from './ui/classes.ts';

const PLATFORM: Record<GatewayStatus['platform'], string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
};
const priority = (g: GatewayStatus) =>
  g.failed ? 0 : g.status === 'error' ? 1 : g.status === 'connecting' ? 2 : g.status === 'connected' ? 3 : 4;

export function gatewayStatusLinks(items: GatewayStatus[]) {
  return [...items]
    .sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((g) => {
      const value = g.failed
        ? `${g.failed} failed`
        : { connected: 'connected', connecting: 'connecting', error: 'not connected', off: 'off' }[g.status];
      const dot: DotTone =
        g.failed || g.status === 'error'
          ? 'warn'
          : g.status === 'connected'
            ? 'on'
            : g.status === 'connecting'
              ? 'busy'
              : 'off';
      return {
        id: g.id,
        label: g.name,
        value,
        dot,
        href: `#/settings?tab=gateways&${g.failed ? 'messages' : 'instance'}=${encodeURIComponent(g.id)}`,
        title: `${g.name} · ${PLATFORM[g.platform]} · ${g.projectName} · ${value}`,
      };
    });
}
