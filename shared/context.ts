import type { ChatItem } from './types.ts';

export const isReset = (item: ChatItem): boolean => item.type === 'meta' && !!item.reset;
export function memoryStart(items: ChatItem[]): number {
  return items.findLastIndex(isReset) + 1;
}
export const kTokens = (n: number | undefined): string =>
  n == null ? '?' : n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
