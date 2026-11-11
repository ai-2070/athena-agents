import { bus, getSecrets } from './store.ts';
import { apiErrorMessage, numberOf, objectOf } from './apiresponse.ts';
import type { FetchError } from './util.ts';
import type { VeniceAccountInfo } from '../shared/types.ts';

export const VENICE_BASE = 'https://api.venice.ai/api/v1';
let generation = 0;
let cached: { at: number; value: VeniceAccountInfo } | null = null;
let pending: { generation: number; promise: Promise<VeniceAccountInfo> } | null = null;

// A settings event may remove or replace the key while a request is in flight.
bus.on('event', (event) => {
  if (event.type !== 'settings') return;
  generation++;
  cached = null;
  pending = null;
});

export function readVeniceAccount(refresh = false): Promise<VeniceAccountInfo> {
  const key = getSecrets().veniceKey;
  if (!key) return Promise.reject(new Error('No Venice key saved.'));
  if (!refresh && cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  if (pending?.generation === generation) return pending.promise;
  const started = generation;
  const promise = (async (): Promise<VeniceAccountInfo> => {
    const response = await fetch(`${VENICE_BASE}/api_keys/rate_limits`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error: FetchError = new Error(apiErrorMessage(json, `Venice said ${response.status}`));
      error.status = response.status;
      throw error;
    }
    const data = objectOf(objectOf(json).data);
    if (typeof data.accessPermitted !== 'boolean')
      throw new Error('Venice returned an unreadable key status. Try again.');
    const balances = objectOf(data.balances);
    const expiresAt =
      typeof data.keyExpiration === 'string' && Number.isFinite(Date.parse(data.keyExpiration))
        ? data.keyExpiration
        : null;
    const value: VeniceAccountInfo = {
      accessPermitted: data.accessPermitted,
      expiresAt,
      expired: !!expiresAt && Date.parse(expiresAt) <= Date.now(),
      balances: {
        usd: numberOf(balances.USD),
        diem: numberOf(balances.DIEM),
        bundled: numberOf(balances.BUNDLED_CREDITS),
      },
    };
    if (started !== generation || getSecrets().veniceKey !== key)
      throw new Error('The Venice key changed. Test the saved key again.');
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => {
    if (pending?.generation === started) pending = null;
  });
  pending = { generation: started, promise };
  return promise;
}
