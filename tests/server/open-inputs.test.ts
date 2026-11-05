// openInputs: steering for a CLI whose input stays open while it works (Claude Code, pi, oh-my-pi). A message
// sent then is written in and stays unread until the engine says it read it; once its input closes it takes
// no more.
import { describe, expect, it } from 'vitest';
import { openInputs } from '../../server/engines/cli.ts';
import type { RunEvent } from '../../shared/types.ts';

function setup() {
  const { steer, open } = openInputs('The test CLI');
  const written: string[] = [];
  const events: RunEvent[] = [];
  let ended = 0;
  const input = open('r1', {
    take: (m) => (m.text === 'no' ? false : (written.push(m.text), `k-${m.id}`)),
    end: () => void ended++,
    onEvent: (e) => events.push(e),
  });
  return { steer, input, written, events, ended: () => ended };
}

describe('openInputs', () => {
  it('writes a message in, keeps it unread, and shows it once read', async () => {
    const { steer, input, written, events } = setup();
    expect(steer.can('r1')).toBe(true);
    await steer.send('r1', { id: 's1', text: 'make it blue', from: 'Ann', teamMessageId: 't1' });
    expect(written).toEqual(['make it blue']);
    expect([...input.unread.keys()]).toEqual(['k-s1']);
    input.read('k-s1');
    input.read('k-s1');
    expect(events).toEqual([{ kind: 'steer', id: 's1', text: 'make it blue', from: 'Ann', teamMessageId: 't1' }]);
    expect(input.unread.size).toBe(0);
  });

  it("one it can't take is refused; one it didn't take is dropped without being shown", async () => {
    const { steer, input, events } = setup();
    await expect(steer.send('r1', { id: 's1', text: 'no' })).rejects.toThrow('The test CLI is no longer reading');
    await steer.send('r1', { id: 's2', text: 'yes' });
    input.drop('k-s2');
    expect(input.unread.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('closes once: it then takes no more, and a run it never knew is refused', async () => {
    const { steer, input, ended } = setup();
    input.close();
    input.close();
    expect(ended()).toBe(1);
    expect(input.isOpen()).toBe(false);
    expect(steer.can('r1')).toBe(false);
    await expect(steer.send('r1', { id: 's1', text: 'late' })).rejects.toThrow('no longer reading');
    await expect(steer.send('other', { id: 's2', text: 'x' })).rejects.toThrow('no longer reading');
  });

  it('closeIn closes after a while, unless wait() comes first', async () => {
    const { input, ended } = setup();
    input.closeIn(20);
    input.wait();
    await new Promise((r) => setTimeout(r, 40));
    expect(ended()).toBe(0);
    input.closeIn(20);
    await new Promise((r) => setTimeout(r, 40));
    expect(ended()).toBe(1);
  });
});
