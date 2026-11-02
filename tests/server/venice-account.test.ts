import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSecret } from '../../server/store.ts';
import { readVeniceAccount, VENICE_BASE } from '../../server/venice.ts';
import { veniceUsage } from '../../server/status.ts';

const account = (extra: Record<string, unknown> = {}) => Response.json({ data: {
  accessPermitted: true, balances: { USD: 3.5, DIEM: 12, BUNDLED_CREDITS: 0 }, keyExpiration: null, ...extra,
} });

beforeEach(() => setSecret('veniceKey', 'venice-inference-test'));
afterEach(() => {
  setSecret('veniceKey', null);
  vi.unstubAllGlobals();
});

describe('Venice key validation and balances', () => {
  it('uses the authenticated non-billable endpoint and returns only normalized account fields', async () => {
    const fetcher = vi.fn(async () => account({ apiTier: { id: 'paid' }, key: 'private-upstream-field' }));
    vi.stubGlobal('fetch', fetcher);
    const result = await readVeniceAccount(true);
    expect(fetcher).toHaveBeenCalledWith(`${VENICE_BASE}/api_keys/rate_limits`, {
      headers: { authorization: 'Bearer venice-inference-test' }, signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({ accessPermitted: true, expiresAt: null, expired: false, balances: { usd: 3.5, diem: 12, bundled: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/private-upstream|inference-test/);
    expect(await veniceUsage()).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await readVeniceAccount(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps blocked access, expiration, zero balances and missing balances distinct', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => account({
      accessPermitted: false, keyExpiration: '2000-01-01T00:00:00.000Z', balances: { USD: '0', DIEM: null, BUNDLED_CREDITS: 'invalid' },
    })));
    expect(await readVeniceAccount()).toEqual({ accessPermitted: false, expiresAt: '2000-01-01T00:00:00.000Z', expired: true, balances: { usd: 0, diem: null, bundled: null } });
  });

  it.each([
    [401, 'Invalid key'], [403, 'This source IP is not allowed'], [429, 'Slow down'], [500, { message: 'Try later' }],
  ])('preserves HTTP %s and its error message', async (status, error) => {
    vi.stubGlobal('fetch', async () => Response.json({ error }, { status }));
    await expect(readVeniceAccount()).rejects.toMatchObject({ status, message: typeof error === 'string' ? error : error.message });
    expect(await veniceUsage()).toBeNull();
  });

  it('does not reuse another key\'s account or cache a late response after removal', async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(async () => account({ balances: { USD: 99 } }));
    vi.stubGlobal('fetch', fetcher);
    const old = readVeniceAccount();
    const rejected = expect(old).rejects.toThrow('key changed');
    setSecret('veniceKey', 'new-key');
    expect((await readVeniceAccount()).balances.usd).toBe(99);
    finish(account());
    await rejected;
    expect((await readVeniceAccount()).balances.usd).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(2);
    setSecret('veniceKey', null);
    expect(await veniceUsage()).toBeNull();
    await expect(readVeniceAccount()).rejects.toThrow('No Venice key');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects unreadable success responses and retries after a network failure', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Timed out')).mockResolvedValueOnce(Response.json({ data: {} })).mockImplementation(async () => account());
    vi.stubGlobal('fetch', fetcher);
    await expect(readVeniceAccount()).rejects.toThrow('Timed out');
    await expect(readVeniceAccount()).rejects.toThrow('unreadable key status');
    expect((await readVeniceAccount()).accessPermitted).toBe(true);
  });
});
