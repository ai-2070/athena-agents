// Codex usage limits and free limit resets, as `codex app-server` reports them (account/rateLimits/read).
import { describe, expect, it } from 'vitest';
import { parseCodexLimits, windowLabel } from '../../server/codexlimits.ts';

const now = Date.UTC(2026, 9, 27, 12);
const sec = (ms: number) => Math.round(ms / 1000);
const DAY = 86_400_000;

// the shape Codex 0.163 answers with (trimmed)
const answer = (over: Record<string, unknown> = {}) => ({
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', primary: { usedPercent: 41.6, windowDurationMins: 300, resetsAt: sec(now + 3_600_000) }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: sec(now + 4 * DAY) }, planType: 'prolite' },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      { id: 'later', resetType: 'codexRateLimits', status: 'available', grantedAt: sec(now - DAY), expiresAt: sec(now + 20 * DAY), title: 'Full reset' },
      { id: 'sooner', resetType: 'codexRateLimits', status: 'available', grantedAt: sec(now - 9 * DAY), expiresAt: sec(now + 2.5 * DAY), title: 'Full reset' },
    ],
  },
  ...over,
});

describe('windowLabel', () => {
  it('names a window by its length', () => {
    expect(windowLabel(300, 'Session')).toBe('5h');
    expect(windowLabel(10080, 'Session')).toBe('Week');
    expect(windowLabel(2880, 'x')).toBe('2d');
    expect(windowLabel(null, 'Session')).toBe('Session');
  });
});

describe('parseCodexLimits', () => {
  it('reads both windows, the plan and the resets, the one that runs out first first', () => {
    const l = parseCodexLimits(answer(), now);
    expect(l.plan).toBe('prolite');
    expect(l.blocked).toBe(false);
    expect(l.windows).toEqual([
      { label: '5h', percent: 42, resetsAt: now + 3_600_000 },
      { label: 'Week', percent: 12, resetsAt: now + 4 * DAY },
    ]);
    expect(l.resets?.available).toBe(2);
    expect(l.resets?.credits.map((c) => c.id)).toEqual(['sooner', 'later']);
    expect(l.resets?.credits[0].expiresAt).toBe(now + 2.5 * DAY);
  });

  it('a plan with only a weekly limit shows just that', () => {
    const l = parseCodexLimits(answer({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: sec(now + 6 * DAY) }, secondary: null, planType: 'plus' } }), now);
    expect(l.windows).toEqual([{ label: 'Week', percent: 0, resetsAt: now + 6 * DAY }]);
  });

  it('a window that has already reset starts again from nothing', () => {
    const l = parseCodexLimits(answer({ rateLimits: { primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: sec(now - 60_000) } } }), now);
    expect(l.windows).toEqual([{ label: '5h', percent: 0, resetsAt: null }]);
  });

  it('leaves out resets that are used or out of date, and counts them out too', () => {
    const l = parseCodexLimits(
      answer({
        rateLimitResetCredits: {
          availableCount: 3,
          credits: [
            { id: 'old', status: 'available', expiresAt: sec(now - 1000) },
            { id: 'used', status: 'redeemed', expiresAt: sec(now + DAY) },
            { id: 'ok', status: 'available', expiresAt: null },
          ],
        },
      }),
      now,
    );
    expect(l.resets?.credits.map((c) => c.id)).toEqual(['ok']);
    expect(l.resets?.available).toBe(1);
  });

  it('trusts the count when Codex sends no details, or a list cut short', () => {
    expect(parseCodexLimits(answer({ rateLimitResetCredits: { availableCount: 4, credits: null } }), now).resets).toEqual({ available: 4, credits: [] });
    const cut = parseCodexLimits(answer({ rateLimitResetCredits: { availableCount: 5, credits: [{ id: 'a', status: 'available', expiresAt: sec(now + DAY) }] } }), now);
    expect(cut.resets?.available).toBe(5);
  });

  it('no resets on the account, a blocked plan, or nonsense', () => {
    expect(parseCodexLimits(answer({ rateLimitResetCredits: null }), now).resets).toBeNull();
    expect(parseCodexLimits(answer({ ordinaryUsageAllowed: false }), now).blocked).toBe(true);
    expect(parseCodexLimits(null, now)).toEqual({ plan: null, windows: [], resets: null, blocked: false });
    expect(parseCodexLimits({ rateLimits: { primary: { usedPercent: '50' } } }, now).windows).toEqual([]);
  });
});
