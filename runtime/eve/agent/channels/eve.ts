import { createHash, timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import { z } from 'zod';
import { bridgeCall } from '../lib/bridge.ts';
import { canonical } from '../../../../shared/canonical.ts';

export default eveChannel({
  onMessage: async ({ eve }, message) => {
    const runId = eve.request.headers.get('x-athena-run');
    if (!runId) return { auth: eve.caller };
    const binding = eve.caller?.attributes?.binding;
    if (typeof binding !== 'string' || !binding) throw new Error('This input has no Athena binding.');
    const result = await bridgeCall(binding, '/admission', {
      runId,
      sessionId: eve.sessionId,
      messageHash: createHash('sha256').update(canonical(message)).digest('hex'),
    });
    const input = z
      .object({ history: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string() })) })
      .parse(result);
    return { auth: eve.caller, history: input.history };
  },
  auth: async (request) => {
    const token = process.env.ATHENA_EVE_TOKEN;
    const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '');
    const binding = request.headers.get('x-athena-binding');
    if (!token || !supplied || !binding) return null;
    const expected = Buffer.from(token);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return { principalId: binding, principalType: 'service', authenticator: 'athena', attributes: { binding } };
  },
});
