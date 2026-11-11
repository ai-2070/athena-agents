// Restoring a backup and copying a project run one at a time (backup.oneAtATime): a second one is refused
// with 409 while the first goes, what fails is answered 400 in its own words, and the next can run after either.
import { describe, expect, it } from 'vitest';
import { oneAtATime } from '../../server/backup.ts';
import { startScreenDone, startScreenPending } from '../../server/projects.ts';

describe('oneAtATime', () => {
  it('refuses a second one while the first goes, then lets the next one run', async () => {
    let finish: () => void = () => {};
    const first = oneAtATime('busy', () => new Promise<string>((resolve) => (finish = () => resolve('done'))));
    await expect(oneAtATime('Another one is going.', async () => 'second')).rejects.toMatchObject({
      message: 'Another one is going.',
      status: 409,
    });
    finish();
    expect(await first).toBe('done');
    expect(await oneAtATime('busy', async () => 'next')).toBe('next');
  });

  it('answers what failed with 400 and its message, and frees the lock', async () => {
    await expect(
      oneAtATime('busy', async () => {
        throw Object.assign(new Error('That backup is damaged.'), { status: 500 });
      }),
    ).rejects.toMatchObject({ message: 'That backup is damaged.', status: 400 });
    expect(await oneAtATime('busy', async () => 1)).toBe(1);
  });
});

describe('the start screen', () => {
  it('is shown until a project is picked, made or restored', () => {
    expect(startScreenPending()).toBe(true);
    startScreenDone();
    expect(startScreenPending()).toBe(false);
  });
});
