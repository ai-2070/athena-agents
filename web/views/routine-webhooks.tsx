// A routine's webhooks: other services start the routine by sending to a webhook's secret address. Shown in the
// routine's editor, with each webhook's deliveries. The address and a secret Athena makes are shown once, when made.
import { useCallback, useEffect, useState } from 'react';
import { ago, attempt, confirmBox, copy, navigate, toast } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button, IconButton } from '../ui/button.tsx';
import { Field, Switch } from '../ui/controls.tsx';
import { FormSection } from '../ui/formsection.tsx';
import { Dot, Pill } from '../ui/marks.tsx';
import { openModal } from '../ui/overlays.tsx';
import { Icon, useServerEvents } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import type { PillTone } from '../ui/classes.ts';
import type {
  WebhookCreated,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookListing,
  WebhookPreset,
  WebhookStatus,
  WebhookVerify,
} from '../../shared/types.ts';

export const PRESETS: { value: WebhookPreset; label: string; icon: string }[] = [
  { value: 'github', label: 'GitHub', icon: 'git-branch' },
  { value: 'gitlab', label: 'GitLab', icon: 'git-branch' },
  { value: 'stripe', label: 'Stripe', icon: 'webhook' },
  { value: 'slack', label: 'Slack', icon: 'webhook' },
  { value: 'linear', label: 'Linear', icon: 'webhook' },
  { value: 'standard', label: 'Standard Webhooks (Svix, Resend, Clerk…)', icon: 'webhook' },
  { value: 'hmac', label: 'Other, signed', icon: 'key-round' },
  { value: 'token', label: 'Other, with a token', icon: 'key-round' },
  { value: 'none', label: 'Address only (weakest)', icon: 'link' },
];
const presetName = (p: WebhookPreset) => PRESETS.find((x) => x.value === p)?.label.replace(/ \(.*\)$/, '') || p;

/** The sender gives the secret (paste it); for the others Athena makes one unless you paste your own. */
const SENDER_SECRET = new Set<WebhookPreset>(['stripe', 'slack', 'linear', 'standard']);

const SECRET_HINT: Record<WebhookPreset, string> = {
  github: 'Leave empty and Athena makes one, to paste into GitHub.',
  gitlab: 'Leave empty and Athena makes one, to paste into GitLab as the secret token.',
  stripe: "Stripe's signing secret for this endpoint (whsec_…).",
  slack: "Your Slack app's signing secret (Basic Information).",
  linear: 'The signing secret Linear shows for this webhook.',
  standard: 'The signing secret the sender shows (often whsec_…).',
  hmac: 'Leave empty and Athena makes one.',
  token: 'Leave empty and Athena makes one.',
  none: '',
};

const EVENT_HINT: Partial<Record<WebhookPreset, string>> = {
  github: 'e.g. push, pull_request.opened, issues.opened',
  gitlab: 'e.g. Push Hook, Merge Request Hook',
  stripe: 'e.g. invoice.paid, checkout.session.completed',
  slack: 'e.g. app_mention, message',
  linear: 'e.g. Issue, Comment',
};

/** Where to paste the address (and secret) for each sender. */
export function pasteNote(v: WebhookVerify): string {
  switch (v.preset) {
    case 'github':
      return "In GitHub: the repository's Settings › Webhooks › Add webhook. Payload URL: the address. Content type: application/json. Secret: the secret.";
    case 'gitlab':
      return "In GitLab: the project's Settings › Webhooks › Add new webhook. URL: the address. Secret token: the secret.";
    case 'stripe':
      return 'In Stripe: Developers › Webhooks › Add endpoint, with the address. Its signing secret is already saved here.';
    case 'slack':
      return "In your Slack app: Event Subscriptions › Request URL (or a slash command's Request URL): the address.";
    case 'linear':
      return 'In Linear: Settings › API › Webhooks: the address. Its signing secret is already saved here.';
    case 'standard':
      return 'Give the sender the address. Its signing secret is already saved here.';
    case 'hmac':
      return `Give the sender the address and the secret: it signs each body with it, in the ${v.header || 'x-signature'} header.`;
    case 'token':
      return v.header && v.header !== 'authorization'
        ? `Give the sender the address, and have it send the token in the ${v.header} header.`
        : 'Give the sender the address, and have it send the token as Authorization: Bearer <token>.';
    case 'none':
      return 'Give the sender the address. Anyone who has it can start this routine, so keep it private.';
  }
}

const DELIVERY_LOOK: Record<WebhookDeliveryStatus, { tone: PillTone; label: string }> = {
  started: { tone: 'ok', label: 'Started' },
  duplicate: { tone: 'dim', label: 'Repeat' },
  skipped: { tone: 'dim', label: 'Skipped' },
  limited: { tone: 'warn', label: 'Held back' },
  refused: { tone: 'bad', label: 'Refused' },
  failed: { tone: 'bad', label: 'Failed' },
};

/** A value to copy: the address or a secret. */
function CopyBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-dim">{label}</span>
      <div className="flex items-center gap-2 rounded-ctl border border-line bg-panel-2 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 font-mono text-[12px] leading-[normal] font-normal wrap-anywhere text-ink">
          {value}
        </code>
        <IconButton
          title={`Copy the ${label.toLowerCase()}`}
          aria-label={`Copy the ${label.toLowerCase()}`}
          onClick={() => copy(value)}
        >
          <Icon name="copy" size={14} />
        </IconButton>
      </div>
    </div>
  );
}

/** A webhook's full address again, with where to paste it. */
async function showAddress(h: WebhookListing): Promise<void> {
  const got = await attempt(() => rpc.webhooks.address({ id: h.id }));
  if (!got) return;
  openModal(
    h.name,
    (close) => (
      <>
        <div className="modal-body">
          <div className="webhook-address flex flex-col gap-4 [&_p]:m-0">
            <CopyBox label="Address" value={got.address} />
            <p className="text-[13px] text-dim">{pasteNote(h.verify)}</p>
          </div>
        </div>
        <div className="modal-foot">
          <Button onClick={close}>Done</Button>
        </div>
      </>
    ),
    { medium: true },
  );
}

/** The address and secret, the one time the secret is shown. */
export function showMade(made: WebhookCreated, title = 'Webhook ready'): void {
  const local = !!made.address && /^http:\/\/127\.0\.0\.1:/.test(made.address);
  openModal(
    title,
    (close) => (
      <>
        <div className="modal-body">
          <div className="webhook-made flex flex-col gap-4 [&_p]:m-0">
            {made.address ? <CopyBox label="Address" value={made.address} /> : null}
            {made.secret ? <CopyBox label="Secret" value={made.secret} /> : null}
            {made.address ? <p className="text-[13px] text-dim">{pasteNote(made.webhook.verify)}</p> : null}
            {local ? (
              <p className="flex items-start gap-2 rounded-ctl border border-line bg-panel-2 px-3 py-2.5 text-[13px] text-dim">
                <Icon name="globe" size={14} className="mt-0.5 flex-none" />
                <span>
                  This is this computer's address. To receive webhooks from the internet, share them in{' '}
                  <Button variant="plain" onClick={() => (close(), navigate('#/settings?tab=webhooks'))}>
                    Settings › Webhooks
                  </Button>
                  , then use Show address on the webhook for its address there.
                </span>
              </p>
            ) : null}
            {made.secret ? (
              <p className="text-[12.5px] text-faint">The secret is shown only now. If you lose it, make a new one.</p>
            ) : null}
          </div>
        </div>
        <div className="modal-foot">
          <Button onClick={close}>Done</Button>
        </div>
      </>
    ),
    { medium: true },
  );
}

const lines = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** Adding or changing a webhook. */
function WebhookForm({
  routineId,
  routineName,
  existing,
  close,
}: {
  routineId: string;
  routineName: string;
  existing?: WebhookListing;
  close: () => void;
}) {
  const [name, setName] = useState(existing?.name || `${routineName} webhook`);
  const [preset, setPreset] = useState<WebhookPreset>(existing?.verify.preset || 'github');
  const [header, setHeader] = useState(existing?.verify.header || '');
  const [algorithm, setAlgorithm] = useState(existing?.verify.algorithm || 'sha256');
  const [encoding, setEncoding] = useState(existing?.verify.encoding || 'hex');
  const [prefix, setPrefix] = useState(existing?.verify.prefix || '');
  const [eventHeader, setEventHeader] = useState(existing?.verify.eventHeader || '');
  const [idHeader, setIdHeader] = useState(existing?.verify.idHeader || '');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState((existing?.events || []).join(', '));
  const [askFirst, setAskFirst] = useState(existing?.askFirst ?? true);
  const [keepBodies, setKeepBodies] = useState(existing?.keepBodies ?? true);
  const [perMinute, setPerMinute] = useState(String(existing?.perMinute ?? 20));
  const [atOnce, setAtOnce] = useState(String(existing?.atOnce ?? 3));
  const [busy, setBusy] = useState(false);
  const generic = preset === 'hmac' || preset === 'token';
  const needsSecret =
    SENDER_SECRET.has(preset) && (!existing || existing.verify.preset !== preset || !existing.hasSecret);
  // (another sender gets a new secret: the saved one was given to the old sender)
  const keepsSecret = !!existing?.hasSecret && existing.verify.preset === preset;

  const verify = (): WebhookVerify => ({
    preset,
    ...(generic && header.trim() ? { header: header.trim() } : {}),
    ...(preset === 'hmac' ? { algorithm, encoding, ...(prefix ? { prefix } : {}) } : {}),
    ...(generic && eventHeader.trim() ? { eventHeader: eventHeader.trim() } : {}),
    ...(generic && idHeader.trim() ? { idHeader: idHeader.trim() } : {}),
  });
  const save = async () => {
    setBusy(true);
    const body = {
      name,
      verify: verify(),
      ...(secret.trim() ? { secret: secret.trim() } : {}),
      events: lines(events),
      askFirst,
      keepBodies,
      perMinute: Number(perMinute) || 20,
      atOnce: Number(atOnce) || 3,
    };
    if (existing) {
      const changed = await attempt(() => rpc.webhooks.change({ id: existing.id, ...body }), 'Saved');
      setBusy(false);
      if (!changed) return;
      close();
      if (changed.secret) showMade(changed, 'New secret');
      return;
    }
    const made = await attempt(() => rpc.webhooks.create({ routineId, ...body }));
    setBusy(false);
    if (!made) return;
    close();
    showMade(made);
  };
  const newAddress = async () => {
    if (!existing) return;
    if (!(await confirmBox('Make a new address? The old one stops working at once.', { ok: 'Make a new address' })))
      return;
    const made = await attempt(() => rpc.webhooks.newAddress({ id: existing.id }));
    if (made) (close(), showMade(made, 'New address'));
  };
  const newSecret = async () => {
    if (!existing) return;
    if (SENDER_SECRET.has(existing.verify.preset)) {
      if (!secret.trim()) return toast(SECRET_HINT[existing.verify.preset], 'warn');
      if (await attempt(() => rpc.webhooks.newSecret({ id: existing.id, secret: secret.trim() }), 'Secret saved'))
        close();
      return;
    }
    if (!(await confirmBox('Make a new secret? The sender needs the new one too.', { ok: 'Make a new secret' })))
      return;
    const made = await attempt(() => rpc.webhooks.newSecret({ id: existing.id }));
    if (made) (close(), showMade(made, 'New secret'));
  };

  return (
    <>
      <div className="modal-body">
        <div className="webhook-form flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Who sends it" group="webhook-sender">
              <SelectControl
                aria-label="Who sends it"
                options={PRESETS}
                value={preset}
                onChange={(v) => setPreset(v as WebhookPreset)}
              />
            </Field>
          </div>
          {generic ? (
            <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
              <Field
                label={preset === 'hmac' ? 'Signature header' : 'Token header'}
                hint={preset === 'hmac' ? 'Default x-signature' : 'Default Authorization'}
              >
                <input
                  value={header}
                  placeholder={preset === 'hmac' ? 'x-signature' : 'authorization'}
                  onChange={(e) => setHeader(e.target.value)}
                />
              </Field>
              <Field label="Event header" hint="Optional">
                <input value={eventHeader} onChange={(e) => setEventHeader(e.target.value)} />
              </Field>
              <Field label="Delivery id header" hint="Optional, to notice repeats">
                <input value={idHeader} onChange={(e) => setIdHeader(e.target.value)} />
              </Field>
            </div>
          ) : null}
          {preset === 'hmac' ? (
            <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
              <Field label="Hash" group="webhook-hash">
                <SelectControl
                  aria-label="Hash"
                  options={[
                    { value: 'sha256', label: 'SHA-256' },
                    { value: 'sha1', label: 'SHA-1' },
                  ]}
                  value={algorithm}
                  onChange={(v) => setAlgorithm(v === 'sha1' ? 'sha1' : 'sha256')}
                />
              </Field>
              <Field label="Written as" group="webhook-encoding">
                <SelectControl
                  aria-label="Written as"
                  options={[
                    { value: 'hex', label: 'Hex' },
                    { value: 'base64', label: 'Base64' },
                  ]}
                  value={encoding}
                  onChange={(v) => setEncoding(v === 'base64' ? 'base64' : 'hex')}
                />
              </Field>
              <Field label="Before the signature" hint="Optional, e.g. sha256=">
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </Field>
            </div>
          ) : null}
          {preset !== 'none' ? (
            <Field
              label={keepsSecret ? 'Signing secret (saved)' : 'Signing secret'}
              hint={keepsSecret ? 'Leave empty to keep the saved one.' : SECRET_HINT[preset]}
            >
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
          ) : (
            <p className="m-0 text-[12.5px] text-amber">
              Anyone who has the address can start this routine. Pick the sender above if it signs its webhooks.
            </p>
          )}
          <Field label="Only these events" hint={`Empty: every event. ${EVENT_HINT[preset] || ''}`.trim()}>
            <input value={events} onChange={(e) => setEvents(e.target.value)} />
          </Field>
          <div className="flex flex-col gap-1">
            <Switch checked={askFirst} onChange={setAskFirst}>
              Agents ask before risky steps
            </Switch>
            <span className="hint">
              For these runs, the agents the routine mentions work at "Ask first". Team members work with their own
              settings.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Switch checked={keepBodies} onChange={setKeepBodies}>
              Keep what was sent for 7 days
            </Switch>
            <span className="hint">To read it and run it again.</span>
          </div>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <Field label="At most a minute">
              <input type="number" min={1} max={600} value={perMinute} onChange={(e) => setPerMinute(e.target.value)} />
            </Field>
            <Field label="At most at once">
              <input type="number" min={1} max={20} value={atOnce} onChange={(e) => setAtOnce(e.target.value)} />
            </Field>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        {existing ? (
          <>
            <Button variant="ghost" onClick={() => void newAddress()}>
              New address
            </Button>
            {existing.verify.preset !== 'none' ? (
              <Button variant="ghost" onClick={() => void newSecret()}>
                {SENDER_SECRET.has(existing.verify.preset) ? 'Save new secret' : 'New secret'}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button disabled={busy || (needsSecret && !secret.trim())} onClick={() => void save()}>
          {existing ? 'Save' : 'Add webhook'}
        </Button>
      </div>
    </>
  );
}

export function openWebhookForm(routineId: string, routineName: string, existing?: WebhookListing): void {
  openModal(
    existing ? 'Change webhook' : 'Add webhook',
    (close) => <WebhookForm routineId={routineId} routineName={routineName} existing={existing} close={close} />,
    { medium: true },
  );
}

function DeliveryRow({ d }: { d: WebhookDelivery }) {
  const [open, setOpen] = useState(false);
  const look = DELIVERY_LOOK[d.status];
  return (
    <li className="webhook-delivery flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <Pill tone={look.tone}>{look.label}</Pill>
        {d.event ? <code className="font-mono text-[12px] text-ink">{d.event}</code> : null}
        <span className="text-dim">{d.reason || (d.routineRunId ? 'The routine started.' : '')}</span>
        <span className="ml-auto text-faint">{ago(d.receivedAt)}</span>
      </div>
      {d.body !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="tiny" onClick={() => setOpen(!open)}>
            <Icon name="eye" size={12} />
            {open ? 'Hide what was sent' : 'What was sent'}
          </Button>
          <Button
            variant="ghost"
            size="tiny"
            onClick={() => void attempt(() => rpc.webhooks.runAgain({ id: d.id }), 'Routine started')}
          >
            <Icon name="rotate-cw" size={12} />
            Run again
          </Button>
        </div>
      ) : null}
      {open && d.body !== undefined ? (
        <pre className="m-0 max-h-60 overflow-auto rounded-ctl border border-line bg-panel-2 p-3 font-mono text-[12px] wrap-anywhere whitespace-pre-wrap text-ink">
          {pretty(d.body)}
        </pre>
      ) : null}
    </li>
  );
}

const pretty = (body: string) => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

function Deliveries({ id }: { id: string }) {
  const [list, setList] = useState<WebhookDelivery[] | null>(null);
  const load = useCallback(
    () =>
      void rpc.webhooks
        .deliveries({ id })
        .then((l) => setList(Array.isArray(l) ? l : []))
        .catch(() => setList([])),
    [id],
  );
  useEffect(load, [load]);
  useServerEvents((ev) => ev.type === 'webhook-deliveries' && load());
  if (!list) return <p className="hint m-0">Loading…</p>;
  if (!list.length) return <p className="hint m-0">Nothing received yet.</p>;
  return (
    <div className="flex flex-col gap-1">
      <ul className="m-0 list-none p-0">
        {list.map((d) => (
          <DeliveryRow key={d.id} d={d} />
        ))}
      </ul>
      {list.some((d) => d.body !== undefined) ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="tiny"
            onClick={() => void attempt(() => rpc.webhooks.removeBodies({ id }), 'Removed')}
          >
            <Icon name="trash-2" size={12} />
            Remove what was kept
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WebhookRow({ h, routineName }: { h: WebhookListing; routineName: string }) {
  const [open, setOpen] = useState(false);
  const last = h.lastDelivery;
  const toggle = (on: boolean) =>
    void attempt(() => rpc.webhooks.change({ id: h.id, enabled: on }), on ? 'Webhook on' : 'Webhook off');
  const remove = async () => {
    if (
      !(await confirmBox(`Delete the webhook "${h.name}"? Its address stops working.`, { ok: 'Delete', danger: true }))
    )
      return;
    await attempt(() => rpc.webhooks.remove({ id: h.id }), 'Deleted');
  };
  const test = async () => {
    const d = await attempt(() => rpc.webhooks.test({ id: h.id }));
    if (!d) return;
    setOpen(true);
    if (d.status === 'skipped') toast('The test passed: every check is fine.');
    else toast(d.reason || 'The test was refused.', 'warn');
  };
  return (
    <li className="webhook-row flex flex-col gap-3 rounded-box border border-line bg-panel-2/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <Dot tone={h.enabled ? 'on' : 'off'} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-ink">{h.name}</div>
          <div className="text-[12.5px] text-dim">
            {presetName(h.verify.preset)} · address …{h.addressHint}
            {h.events.length ? ` · ${h.events.join(', ')}` : ''}
            {h.askFirst ? ' · asks first' : ''}
          </div>
        </div>
        {last ? (
          <span className="flex items-center gap-2 text-[12.5px] text-faint">
            <Pill tone={DELIVERY_LOOK[last.status].tone}>{DELIVERY_LOOK[last.status].label}</Pill>
            {ago(last.receivedAt)}
          </span>
        ) : null}
        <Switch checked={h.enabled} onChange={toggle}>
          <span className="sr-only">{h.enabled ? 'Webhook on' : 'Webhook off'}</span>
        </Switch>
      </div>
      {h.offReason && !h.enabled ? <p className="hint m-0 text-amber!">{h.offReason}</p> : null}
      {h.needsAddress ? (
        <p className="hint m-0 text-amber!">This webhook has no address on this computer. Make a new one.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="tiny" onClick={() => void showAddress(h)}>
          <Icon name="link" size={12} />
          Show address
        </Button>
        <Button variant="ghost" size="tiny" onClick={() => void test()}>
          <Icon name="test-tube" size={12} />
          Send a test
        </Button>
        <Button variant="ghost" size="tiny" onClick={() => setOpen(!open)}>
          <Icon name="history" size={12} />
          {open ? 'Hide deliveries' : 'Deliveries'}
        </Button>
        <Button variant="ghost" size="tiny" onClick={() => openWebhookForm(h.routineId, routineName, h)}>
          <Icon name="pencil" size={12} />
          Change
        </Button>
        <IconButton
          className="ml-auto"
          title="Delete webhook"
          aria-label="Delete webhook"
          onClick={() => void remove()}
        >
          <Icon name="trash-2" size={14} />
        </IconButton>
      </div>
      {open ? <Deliveries id={h.id} /> : null}
    </li>
  );
}

/** The routine editor's Webhooks section. */
export function RoutineWebhooks({ routineId, routineName }: { routineId: string; routineName: string }) {
  const [list, setList] = useState<WebhookListing[] | null>(null);
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const load = useCallback(() => {
    // (an answer that isn't a list leaves the section empty instead of breaking the routine's page)
    void rpc.webhooks
      .list({ routineId })
      .then((l) => setList(Array.isArray(l) ? l : []))
      .catch(() => setList([]));
    void rpc.webhooks
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [routineId]);
  useEffect(load, [load]);
  useServerEvents((ev) => ['webhooks', 'webhook-deliveries', 'webhook-status', 'settings'].includes(ev.type) && load());
  const quiet = status && list?.some((h) => h.enabled) && !status.listening;
  const moved = !!status?.tunnel?.changed && !!list?.length;
  return (
    <FormSection
      icon="webhook"
      title="Webhooks"
      hint="Start this routine when another service sends a webhook: GitHub, Stripe, Linear, Slack, n8n and others."
      end={
        <Button variant="ghost" size="tiny" onClick={() => openWebhookForm(routineId, routineName)}>
          <Icon name="plus" size={12} />
          Add webhook
        </Button>
      }
    >
      {quiet ? (
        <p className="hint m-0 inline-flex items-center gap-1.5 text-amber!">
          <Icon name="triangle-alert" size={12} />
          {status.error || 'Webhooks are not being received.'} <a href="#/settings?tab=webhooks">Settings › Webhooks</a>
        </p>
      ) : null}
      {moved ? (
        <div className="webhook-moved flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-panel-2 px-3 py-2.5 text-[13px] text-amber">
          <Icon name="triangle-alert" size={13} />
          <span className="min-w-0 flex-1">
            The Cloudflare address changed. Give each sender its webhook's new address (Show address).
          </span>
          <Button
            variant="ghost"
            size="tiny"
            onClick={() => void attempt(() => rpc.webhooks.seen()).then((s) => s && setStatus(s))}
          >
            Done
          </Button>
        </div>
      ) : null}
      {list === null ? (
        <p className="hint m-0">Loading…</p>
      ) : list.length ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map((h) => (
            <WebhookRow key={h.id} h={h} routineName={routineName} />
          ))}
        </ul>
      ) : (
        <p className="hint m-0">No webhooks yet.</p>
      )}
    </FormSection>
  );
}
