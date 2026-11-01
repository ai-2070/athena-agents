/** JSON from a provider is an untrusted boundary. */
export const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function numberOf(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function apiErrorMessage(value: unknown, fallback: string): string {
  const error = objectOf(value).error;
  const message = typeof error === 'string' ? error : objectOf(error).message;
  return typeof message === 'string' && message ? message.slice(0, 600) : fallback;
}
