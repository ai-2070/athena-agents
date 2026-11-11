import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { WhatsAppSetupView } from '../../web/views/gateway-whatsapp-setup.tsx';
import type {
  GatewayInstance,
  GatewayWhatsAppRecovery,
  GatewayWhatsAppReplacement,
  GatewayWhatsAppSetup,
} from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const instance: GatewayInstance & { credentials: Record<string, boolean> } = {
  id: 'g1',
  name: 'Business phone',
  platform: 'whatsapp',
  accountId: '9900000001',
  projectId: 'p1',
  target: { kind: 'brain' },
  senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] },
  scope: { directMessages: true, conversationIds: [], guildIds: [] },
  fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
  enabled: false,
  routeGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
  credentials: { accessToken: true, signingSecret: true, relayKey: true },
};
let host: HTMLElement;
let unmount: () => void;
let setup: GatewayWhatsAppSetup;
let recovery: GatewayWhatsAppRecovery;
let replacement: GatewayWhatsAppReplacement;
let calls: { url: string; method: string; body: Record<string, unknown> }[];
let fail: string;
let close: () => void;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (label: string, root: ParentNode = host) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
async function type(label: string, text: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  setup = { paired: false, pending: null, recoveryRequired: false };
  recovery = { reason: null, gap: null };
  replacement = { revision: null, retired: 0 };
  calls = [];
  fail = '';
  close = vi.fn();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (method === 'GET')
      return new Response(
        JSON.stringify(
          url.endsWith('/whatsapp-senders')
            ? { reason: '', retired: 1, waiting: 0, unallowed: 0, senders: [] }
            : url.endsWith('/whatsapp-setup')
              ? setup
              : url.endsWith('/whatsapp-replacement')
                ? replacement
                : recovery,
        ),
      );
    if (fail) {
      if (url.endsWith('/whatsapp-pairing'))
        setup = { paired: false, pending: { phase: 'requesting', revision: 'a'.repeat(64) }, recoveryRequired: true };
      return new Response(JSON.stringify({ error: fail }), { status: 409 });
    }
    if (url.endsWith('/whatsapp-setup/check'))
      return new Response(JSON.stringify({ checkedAt: 1700000000000, account: 'verified', relay: 'ready' }));
    if (url.endsWith('/whatsapp-pairing') || url.endsWith('/whatsapp-pairing/finish'))
      setup = { paired: true, pending: null, recoveryRequired: false };
    if (url.endsWith('/whatsapp-pairing/replace'))
      setup = {
        paired: true,
        pending: { phase: 'received', revision: 'e'.repeat(64), replacement: true },
        recoveryRequired: false,
      };
    if (url.endsWith('/whatsapp-pairing/review')) setup = { paired: false, pending: null, recoveryRequired: false };
    if (url.endsWith('/whatsapp-recovery/inspect')) {
      recovery = { reason: 'gap', gap: { at: 1700000000000, revision: 'b'.repeat(64) } };
      setup.recoveryRequired = true;
    }
    if (url.endsWith('/whatsapp-recovery') || url.endsWith('/whatsapp-recovery/restore')) {
      recovery = { reason: null, gap: null };
      setup.recoveryRequired = false;
    }
    return new Response(JSON.stringify(setup));
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});
async function open(enabled = false, credentials = instance.credentials) {
  await act(async () => {
    unmount = mountReact(
      host,
      <WhatsAppSetupView
        instance={{ ...instance, enabled, credentials }}
        close={close}
        changed={async () => {}}
        pause={async () => {}}
        edit={() => {}}
      />,
    ).unmount;
  });
  await settle();
}
async function form() {
  await type('Relay HTTPS address', 'https://relay.example');
  await type('Business account ID', '9000000001');
  await type('Pairing code', 'c'.repeat(64));
}

it('loads secret-free setup without making a pairing/check request automatically', async () => {
  await open();
  expect(host.textContent).toContain('receiving and sending remain disabled');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Pairing code"]')!.type).toBe('password');
  expect(calls.filter((item) => item.method !== 'GET')).toEqual([]);
  expect(host.querySelector('[aria-label="Access token"]')).toBeNull();
});
it('opens sender review from a paired relay and returns to setup without a mutation', async () => {
  setup.paired = true;
  await open();
  await click('Review senders');
  await settle();
  expect(host.textContent).toContain('WhatsApp senders');
  expect(host.textContent).toContain('1 retired sender ID stays blocked');
  await click('Back to relay setup');
  await settle();
  expect(host.textContent).toContain('Relay paired');
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
});
it('confirms one pairing, clears its code and keeps the connection disabled', async () => {
  await open();
  await form();
  await click('Pair relay');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  await click('Pair relay', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    {
      url: '/api/gateways/g1/whatsapp-pairing',
      method: 'POST',
      body: {
        origin: 'https://relay.example',
        businessAccountId: '9000000001',
        code: 'c'.repeat(64),
        acknowledgeStart: true,
      },
    },
  ]);
  expect(host.textContent).toContain('Relay paired');
  expect(host.textContent).not.toContain('c'.repeat(64));
  expect(button('Enable')).toBeUndefined();
});
it('does not retry an unknown pairing and offers its saved review after a failed response', async () => {
  await open();
  await form();
  fail = 'Pairing outcome unknown.';
  await click('Pair relay');
  await settle();
  await click('Pair relay', document.querySelector('.modal')!);
  await settle();
  expect(host.textContent).toContain('Pairing outcome unknown');
  expect(host.querySelector('[aria-label="Pairing code"]')).toBeNull();
  expect(button('Pair relay')).toBeUndefined();
  expect(calls.filter((item) => item.method === 'POST')).toHaveLength(1);
  expect(button('Review unknown pairing')).toBeDefined();
});
it('finishes a received key using only its saved revision', async () => {
  setup.pending = { phase: 'received', revision: 'a'.repeat(64) };
  await open();
  await click('Finish saved pairing');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    { url: '/api/gateways/g1/whatsapp-pairing/finish', method: 'POST', body: { revision: 'a'.repeat(64) } },
  ]);
  expect(host.textContent).toContain('Relay paired');
});
it('requires explicit remote-revocation acknowledgement to clear an unknown attempt', async () => {
  setup.pending = { phase: 'requesting', revision: 'a'.repeat(64) };
  await open();
  await click('Review unknown pairing');
  await settle();
  expect(document.querySelector('.modal')?.textContent).toContain('does not revoke the relay');
  await click('I revoked the pairing', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')[0]).toMatchObject({
    body: { revision: 'a'.repeat(64), acknowledgeRemoteRevoked: true },
  });
});
it('runs a setup check only on request and reports an observation rather than enabling the instance', async () => {
  setup.paired = true;
  await open();
  expect(calls.filter((item) => item.method === 'POST')).toHaveLength(0);
  await click('Check setup');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    { url: '/api/gateways/g1/whatsapp-setup/check', method: 'POST', body: {} },
  ]);
  expect(host.textContent).toContain('Account verified');
  expect(host.textContent).toContain('does not enable');
});
it('disables checks while enabled or when account credentials are missing', async () => {
  setup.paired = true;
  await open(true);
  expect(button('Check setup').disabled).toBe(true);
  expect(button('Pause instance')).toBeDefined();
  act(() => unmount());
  await open(false, { relayKey: true });
  expect(button('Check setup').disabled).toBe(true);
  expect(button('Edit instance')).toBeDefined();
});
it('saves a gap observation and then confirms the exact revision without calling administrative endpoints', async () => {
  setup.paired = true;
  await open();
  await click('Check relay gap');
  await settle();
  await click('Review gap locally');
  await settle();
  expect(document.querySelector('.modal')?.textContent).toContain('Saved work, files and delivery receipts stay held');
  await click('Accept reviewed gap', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST').map((item) => item.url)).toEqual([
    '/api/gateways/g1/whatsapp-recovery/inspect',
    '/api/gateways/g1/whatsapp-recovery',
  ]);
  expect(calls.find((item) => item.url.endsWith('/whatsapp-recovery') && item.method === 'POST')?.body).toEqual({
    revision: 'b'.repeat(64),
    acknowledgeGap: true,
  });
});
it('confirms an exact restoration review while keeping gap and replacement controls separate', async () => {
  setup.paired = true;
  recovery = { reason: 'installation', gap: null, restoration: { at: 1700000000000, revision: 'd'.repeat(64) } };
  await open();
  expect(button('Check relay gap')).toBeUndefined();
  expect(host.textContent).toContain('Restore the saved relay');
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  await click('Check restored relay');
  await settle();
  expect(document.querySelector('.modal')?.textContent).toContain('does not pair a new relay');
  expect(button('Check setup').textContent).toBe('Check setup');
  expect(button('Check setup').disabled).toBe(true);
  await click('Check restored relay', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    {
      url: '/api/gateways/g1/whatsapp-recovery/restore',
      method: 'POST',
      body: { revision: 'd'.repeat(64), acknowledgeRestore: true },
    },
  ]);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('instance stays paused');
  expect(button('Enable')).toBeUndefined();
});
it('preserves the restoration hold and shows a reloadable error when the original relay does not match', async () => {
  setup.paired = true;
  recovery = { reason: 'epoch', gap: null, restoration: { at: 1700000000000, revision: 'd'.repeat(64) } };
  fail = 'The relay no longer matches';
  await open();
  await click('Check restored relay');
  await settle();
  await click('Check restored relay', document.querySelector('.modal')!);
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('no longer matches');
  expect(button('Check restored relay')).toBeDefined();
  expect(host.textContent).not.toContain('Connection hold cleared');
});
it('requires pause for restoration and makes no request after its confirmation is cancelled or closed', async () => {
  setup.paired = true;
  recovery = { reason: 'cursor', gap: null, restoration: { at: 1700000000000, revision: 'd'.repeat(64) } };
  await open(true);
  expect(button('Check restored relay').disabled).toBe(true);
  act(() => unmount());
  await open();
  await click('Check restored relay');
  await settle();
  await click('Cancel', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  const restore = button('Check restored relay');
  await act(async () => {
    restore.click();
    restore.click();
  });
  await settle();
  act(() => unmount());
  await click('Check restored relay', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
});
it('does not pair after navigation closes the confirmation', async () => {
  await open();
  await form();
  await click('Pair relay');
  await settle();
  act(() => unmount());
  await click('Pair relay', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toHaveLength(0);
});
it('prevents rapid repeated pairing clicks from opening duplicate exchanges', async () => {
  await open();
  await form();
  const pair = button('Pair relay');
  await act(async () => {
    pair.click();
    pair.click();
  });
  await settle();
  await click('Pair relay', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.url.endsWith('/whatsapp-pairing') && item.method === 'POST')).toHaveLength(1);
});

it('pairs a replacement once, then requires a separate finish review without exposing the old key', async () => {
  setup.paired = true;
  replacement = { revision: 'd'.repeat(64), retired: 0 };
  await open();
  await click('Replace relay');
  await settle();
  await form();
  await click('Pair replacement');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  expect(document.querySelector('.modal')?.textContent).toContain('permanently stopped the old relay');
  await click('Pair replacement', document.querySelector('.modal')!);
  await settle();
  expect(host.textContent).toContain('Replacement key saved');
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    {
      url: '/api/gateways/g1/whatsapp-pairing/replace',
      method: 'POST',
      body: {
        revision: 'd'.repeat(64),
        origin: 'https://relay.example',
        businessAccountId: '9000000001',
        code: 'c'.repeat(64),
        acknowledgePreviousStopped: true,
        acknowledgeLoss: true,
      },
    },
  ]);
  await click('Finish replacement');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toHaveLength(1);
  expect(document.querySelector('.modal')?.textContent).toContain('ask senders to message again after finishing');
  await click('Finish replacement', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')[1]).toEqual({
    url: '/api/gateways/g1/whatsapp-pairing/finish',
    method: 'POST',
    body: { revision: 'e'.repeat(64), acknowledgeLoss: true },
  });
  expect(host.textContent).toContain('receiving and sending remain disabled');
  expect(button('Enable')).toBeUndefined();
});
it('can cancel replacement without an exchange and refuses it while enabled or when the archive is full', async () => {
  setup.paired = true;
  replacement = { revision: 'd'.repeat(64), retired: 2 };
  await open();
  expect(host.textContent).toContain('2 earlier relay bindings are archived');
  await click('Replace relay');
  await settle();
  await form();
  await click('Cancel replacement');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  act(() => unmount());
  await open(true);
  expect(button('Replace relay').disabled).toBe(true);
  act(() => unmount());
  replacement = { revision: null, retired: 100 };
  await open();
  expect(button('Replace relay').disabled).toBe(true);
});
it('keeps a received replacement after a stale finish and explains revocation for unknown replacement outcomes', async () => {
  setup = {
    paired: true,
    pending: { phase: 'received', revision: 'e'.repeat(64), replacement: true },
    recoveryRequired: false,
  };
  fail = 'Saved work changed';
  await open();
  await click('Finish replacement');
  await settle();
  await click('Finish replacement', document.querySelector('.modal')!);
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Saved work changed');
  expect(button('Finish replacement')).toBeDefined();
  act(() => unmount());
  setup.pending = { phase: 'requesting', revision: 'f'.repeat(64), replacement: true };
  await open();
  expect(host.textContent).toContain('Revoke the new relay pairing');
  expect(host.textContent).toContain('does not restore the old pull key');
  expect(button('Pair replacement')).toBeUndefined();
});
