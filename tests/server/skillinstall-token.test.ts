// "Not signed in to gh" is remembered only a few seconds, so `gh auth login` counts on the next try (BH-058).
import { afterAll, describe, expect, it, vi } from 'vitest';

const gh = vi.hoisted(() => ({ token: '', asked: 0 }));
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (name: string) => (name === 'gh' ? 'gh' : real.which(name)),
    run: async (cmd: string, args: string[], opts?: Parameters<typeof real.run>[2]) => {
      if (cmd !== 'gh') return real.run(cmd, args, opts);
      gh.asked++;
      return { code: gh.token ? 0 : 1, stdout: gh.token, stderr: '' };
    },
  };
});

const { token } = await import('../../server/skillinstall.ts');
const was = process.env.GITHUB_TOKEN;
afterAll(() => {
  vi.useRealTimers();
  if (was !== undefined) process.env.GITHUB_TOKEN = was;
});

describe('the GitHub CLI sign-in', () => {
  it('counts soon after signing in, and a token is kept a while', async () => {
    delete process.env.GITHUB_TOKEN;
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await token()).toBeNull();
    gh.token = 'signed-in';
    // asked again within a moment: still the same answer, without asking gh
    expect(await token()).toBeNull();
    expect(gh.asked).toBe(1);
    vi.setSystemTime(Date.now() + 16_000);
    expect(await token()).toBe('signed-in');
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await token()).toBe('signed-in');
    expect(gh.asked).toBe(2);
  });
});
