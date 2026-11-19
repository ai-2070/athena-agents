// Webhook checks: each sender's signature, with the providers' own published examples where they have them.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { same, signFor, verify } from '../../server/webhooks/verify.ts';
import type { WebhookPreset, WebhookVerify } from '../../shared/types.ts';

const buf = (s: string) => Buffer.from(s, 'utf8');
const NOW = 1_800_000_000_000;

describe("the providers' published examples", () => {
  it('GitHub (docs: "Validating webhook deliveries")', () => {
    const v = verify(
      { preset: 'github' },
      "It's a Secret to Everybody",
      buf('Hello, World!'),
      {
        'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
        'x-github-event': 'push',
        'x-github-delivery': 'abc',
      },
      NOW,
    );
    expect(v).toEqual({ ok: true, event: 'push', senderId: 'abc', ping: false });
  });

  it('Slack (docs: "Verifying requests from Slack")', () => {
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    const v = verify(
      { preset: 'slack' },
      '8f742231b10e8888abcd99yyyzzz85a5',
      buf(body),
      {
        'x-slack-request-timestamp': '1531420618',
        'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
      },
      1531420618_000,
    );
    expect(v).toMatchObject({ ok: true, event: '/webhook-collect' });
  });

  it("Standard Webhooks (the spec's example)", () => {
    const v = verify(
      { preset: 'standard' },
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      buf('{"test": 2432232314}'),
      {
        'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
        'webhook-timestamp': '1614265330',
        'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      },
      1614265330_000,
    );
    expect(v).toMatchObject({ ok: true, senderId: 'msg_p5jXN8AQM9LWM0D4loKWxJek' });
  });
});

describe('every preset', () => {
  const presets: { v: WebhookVerify; secret: string | null; body: string }[] = [
    { v: { preset: 'github' }, secret: 's3cret', body: '{"zen":"hi"}' },
    { v: { preset: 'gitlab' }, secret: 's3cret', body: '{"object_kind":"push"}' },
    { v: { preset: 'stripe' }, secret: 'whsec_abc', body: '{"id":"evt_1","type":"invoice.paid"}' },
    { v: { preset: 'slack' }, secret: 's3cret', body: '{"type":"event_callback","event":{"type":"app_mention"}}' },
    { v: { preset: 'linear' }, secret: 's3cret', body: `{"type":"Issue","webhookTimestamp":${NOW}}` },
    {
      v: { preset: 'standard' },
      secret: `whsec_${Buffer.from('key').toString('base64')}`,
      body: '{"type":"email.sent"}',
    },
    {
      v: { preset: 'hmac', header: 'x-sig', algorithm: 'sha1', encoding: 'base64', prefix: 'sha1=' },
      secret: 's',
      body: '{}',
    },
    { v: { preset: 'token', header: 'x-token' }, secret: 'tok', body: '{"type":"ran"}' },
    { v: { preset: 'token' }, secret: 'tok', body: '{}' },
  ];

  for (const { v, secret, body } of presets) {
    it(`${v.preset}${v.header ? ` (${v.header})` : ''}: passes when signed as the sender signs, fails when changed`, () => {
      const headers = signFor(v, secret, body, NOW);
      expect(verify(v, secret, buf(body), headers, NOW).ok).toBe(true);
      // another body, another secret, no headers
      expect(verify(v, secret, buf(`${body} `), headers, NOW).ok).toBe(v.preset === 'gitlab' || v.preset === 'token');
      expect(verify(v, 'other', buf(body), headers, NOW).ok).toBe(false);
      expect(verify(v, secret, buf(body), {}, NOW)).toMatchObject({ ok: false });
      // no secret saved
      expect(verify(v, null, buf(body), headers, NOW)).toMatchObject({ ok: false, reason: /No secret/ });
    });
  }

  it('reads the event and the delivery id each sender uses', () => {
    const stripe = { preset: 'stripe' as const };
    const body = '{"id":"evt_9","type":"charge.refunded"}';
    expect(verify(stripe, 'k', buf(body), signFor(stripe, 'k', body, NOW), NOW)).toMatchObject({
      event: 'charge.refunded',
      senderId: 'evt_9',
    });
    const slack = { preset: 'slack' as const };
    const sbody = '{"type":"event_callback","event_id":"Ev1","event":{"type":"app_mention"}}';
    expect(verify(slack, 'k', buf(sbody), signFor(slack, 'k', sbody, NOW), NOW)).toMatchObject({
      event: 'app_mention',
      senderId: 'Ev1',
    });
    const named: WebhookVerify = { preset: 'token', header: 'x-token', eventHeader: 'x-kind', idHeader: 'x-id' };
    expect(verify(named, 't', buf('{}'), { 'x-token': 't', 'x-kind': 'build', 'x-id': '7' }, NOW)).toMatchObject({
      event: 'build',
      senderId: '7',
    });
  });

  it("answers GitHub's ping and Slack's address check instead of running", () => {
    const gh = { preset: 'github' as const };
    expect(verify(gh, 'k', buf('{}'), signFor(gh, 'k', '{}', NOW), NOW)).toMatchObject({ ok: true, ping: true });
    const slack = { preset: 'slack' as const };
    const body = '{"type":"url_verification","challenge":"c4"}';
    expect(verify(slack, 'k', buf(body), signFor(slack, 'k', body, NOW), NOW)).toMatchObject({
      ok: true,
      reply: { challenge: 'c4' },
    });
  });

  it('refuses old or future timestamps', () => {
    const late = NOW + 6 * 60_000;
    for (const preset of ['stripe', 'slack', 'standard'] as WebhookPreset[]) {
      const v = { preset };
      const secret = preset === 'standard' ? `whsec_${Buffer.from('k').toString('base64')}` : 'k';
      const headers = signFor(v, secret, '{}', NOW);
      expect(verify(v, secret, buf('{}'), headers, late)).toMatchObject({ ok: false, reason: /too old/ });
      expect(verify(v, secret, buf('{}'), headers, NOW - 6 * 60_000)).toMatchObject({ ok: false });
    }
    const linear = { preset: 'linear' as const };
    const body = `{"webhookTimestamp":${NOW}}`;
    expect(verify(linear, 'k', buf(body), signFor(linear, 'k', body, NOW), NOW + 2 * 60_000)).toMatchObject({
      ok: false,
    });
  });

  it('takes a Bearer token or the bare token in Authorization', () => {
    const v = { preset: 'token' as const };
    expect(verify(v, 'tok', buf('{}'), { authorization: 'Bearer tok' }, NOW).ok).toBe(true);
    expect(verify(v, 'tok', buf('{}'), { authorization: 'tok' }, NOW).ok).toBe(true);
    expect(verify(v, 'tok', buf('{}'), { authorization: 'Bearer nope' }, NOW).ok).toBe(false);
  });

  it('lets an address-only webhook through without a secret', () => {
    expect(verify({ preset: 'none' }, null, buf('{"type":"x"}'), {}, NOW)).toEqual({
      ok: true,
      event: 'x',
      senderId: null,
    });
  });
});

describe('same()', () => {
  it('compares any lengths without throwing', () => {
    expect(same('a', 'a')).toBe(true);
    expect(same('a', 'ab')).toBe(false);
    expect(same(Buffer.from('x'), 'x')).toBe(true);
    expect(same(crypto.randomBytes(8), '')).toBe(false);
  });
});
