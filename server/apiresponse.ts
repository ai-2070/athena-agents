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
  if (typeof message !== 'string' || !message) return fallback;
  const reason = providerReason(value);
  return (reason && !message.includes(reason) ? `${message} (${reason})` : message).slice(0, 900);
}

/** OpenRouter answers only "Provider returned error"; the reason is the provider's own answer, in error.metadata.raw
 *  ("Anthropic: tools.0.custom.input_schema: …"). '' when there is none. */
export function providerReason(value: unknown): string {
  const metadata = objectOf(objectOf(objectOf(value).error).metadata);
  if (typeof metadata.raw !== 'string' || !metadata.raw.trim()) return '';
  let reason = metadata.raw;
  try {
    const answer = objectOf(JSON.parse(metadata.raw));
    const message = objectOf(answer.error).message ?? answer.message;
    if (typeof message === 'string' && message) reason = message;
  } catch {
    /* plain text */
  }
  const from = typeof metadata.provider_name === 'string' && metadata.provider_name ? `${metadata.provider_name}: ` : '';
  return `${from}${reason.trim()}`.slice(0, 600);
}
