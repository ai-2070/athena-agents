import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';

export default eveChannel({
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
