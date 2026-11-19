// Settings › Webhooks: whether webhooks are received, and how the internet reaches them: one choice starts a Cloudflare
// or Tailscale tunnel to the webhooks port (never the dashboard's), or you run your own. Each webhook is made on the
// routine it starts.
import { useCallback, useEffect, useState } from 'react';
import { attempt, copy } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button, IconButton } from '../ui/button.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section, Sections, Segmented, SwitchRow } from '../ui/controls.tsx';
import { Dot } from '../ui/marks.tsx';
import { Icon, useServerEvents } from '../ui/react.tsx';
import type { WebhookShare, WebhookStatus, WebhookTunnel } from '../../shared/types.ts';

/** The listener's state in a few words. */
export function statusLine(s: Omit<WebhookStatus, 'tunnel'>): string {
  if (s.error) return s.error;
  if (!s.on) return 'Off: webhooks are refused.';
  if (s.listening) return `Listening on 127.0.0.1:${s.port}, for webhooks only.`;
  return 'Starts when a webhook is on.';
}

const SHARE_WORDS: Record<Exclude<WebhookShare, 'off'>, string> = {
  cloudflare:
    'A Cloudflare quick tunnel: no account needed, but its address changes every time it starts, and the senders then need the new one. Good for trying webhooks out.',
  'tailscale-public':
    "Tailscale Funnel: your computer's ts.net address, open to the internet. It stays the same, so senders keep working.",
  'tailscale-tailnet':
    'Tailscale Serve: only your own devices on your tailnet can reach it (Home Assistant, n8n, a CI runner on another machine).',
};

const INSTALL: Record<'cloudflared' | 'tailscale', { name: string; link: string; cmd: string }> = {
  cloudflared: {
    name: 'cloudflared',
    link: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    cmd: navigator.userAgent.includes('Mac')
      ? 'brew install cloudflared'
      : 'winget install --id Cloudflare.cloudflared',
  },
  tailscale: {
    name: 'Tailscale',
    link: 'https://tailscale.com/download',
    cmd: navigator.userAgent.includes('Mac')
      ? 'brew install --cask tailscale'
      : 'winget install --id Tailscale.Tailscale',
  },
};

/** The tunnel's state in a few words, and its light. */
export function tunnelLine(t: WebhookTunnel): { text: string; tone: 'on' | 'busy' | 'warn' | 'off' } {
  if (t.state === 'off') return { text: 'Not shared by Athena.', tone: 'off' };
  if (t.state === 'starting') return { text: t.message || 'Starting…', tone: 'busy' };
  if (t.state === 'stopped') return { text: t.message || 'Stopped.', tone: 'warn' };
  if (t.reached === false) return { text: t.message || "Webhooks don't reach this computer yet.", tone: 'warn' };
  return { text: t.reached ? 'On. Webhooks reach this computer.' : 'On. Checking…', tone: t.reached ? 'on' : 'busy' };
}

function Copyable({ value }: { value: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-ctl border border-line bg-panel-2 py-1 pr-1 pl-2.5">
      <code className="min-w-0 font-mono text-[12px] wrap-anywhere text-ink">{value}</code>
      <IconButton title="Copy" aria-label={`Copy ${value}`} onClick={() => copy(value)}>
        <Icon name="copy" size={13} />
      </IconButton>
    </span>
  );
}

function TunnelState({ s, check }: { s: WebhookStatus; check: () => void }) {
  const t = s.tunnel;
  const [details, setDetails] = useState(false);
  const line = tunnelLine(t);
  const tool = t.share === 'cloudflare' ? 'cloudflared' : 'tailscale';
  const missing = t.share !== 'off' && !t.tools[tool];
  return (
    <div className="webhook-tunnel flex flex-col gap-3 px-5 py-4">
      <div className={`flex items-start gap-2.5 text-[13px] ${t.danger ? 'text-red' : 'text-dim'}`}>
        <Dot tone={t.danger ? 'warn' : line.tone} className="mt-1.5 flex-none" />
        <span className="tunnel-line">{line.text}</span>
      </div>
      {t.address && t.state === 'on' ? <Copyable value={t.address} /> : null}
      {t.link ? (
        <div>
          <a className="text-accent" href={t.link} target="_blank" rel="noreferrer">
            {t.linkLabel || 'Open'}
          </a>
        </div>
      ) : null}
      {missing ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px] text-dim">
          To install {INSTALL[tool].name}: <Copyable value={INSTALL[tool].cmd} /> or{' '}
          <a className="text-accent" href={INSTALL[tool].link} target="_blank" rel="noreferrer">
            download it
          </a>
          .
        </p>
      ) : null}
      {t.changed ? (
        <p className="m-0 text-[13px] text-amber">
          The Cloudflare address changed. Each webhook's senders need its new address: open the routine and use Show
          address.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {t.state === 'on' ? (
          <Button variant="ghost" size="small" onClick={check}>
            <Icon name="rotate-cw" size={13} />
            Check now
          </Button>
        ) : null}
        {t.output.length ? (
          <Button variant="ghost" size="small" onClick={() => setDetails(!details)}>
            {details ? 'Hide details' : 'Details'}
          </Button>
        ) : null}
      </div>
      {details ? (
        <pre className="m-0 max-h-52 overflow-auto rounded-ctl border border-line bg-panel-2 p-3 font-mono text-[11.5px] whitespace-pre-wrap text-dim">
          {t.output.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

/** Running your own tunnel: the commands for the webhooks port, and its address. */
function OwnTunnel({ s, save, check }: { s: WebhookStatus; save: (url: string) => void; check: () => void }) {
  const [open, setOpen] = useState(!!s.publicUrl);
  const [url, setUrl] = useState(s.publicUrl);
  useEffect(() => setUrl(s.publicUrl), [s.publicUrl]);
  if (!open)
    return (
      <PanelNote>
        <Button variant="plain" onClick={() => setOpen(true)}>
          I run my own tunnel
        </Button>
      </PanelNote>
    );
  return (
    <>
      <Row
        stack
        title="Your own tunnel"
        description="Point it at the webhooks port, never at the dashboard's. For example:"
      >
        <div className="flex flex-col items-start gap-2">
          <Copyable value={`cloudflared tunnel --url http://127.0.0.1:${s.port}`} />
          <Copyable value={`tailscale funnel ${s.port}`} />
          <Copyable value={`tailscale serve ${s.port}`} />
        </div>
      </Row>
      <FieldRow label="Its address" hint="The https address your tunnel gives, like https://hooks.example.com.">
        <input value={url} placeholder="https://…" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
      </FieldRow>
      <RowActions>
        {s.publicUrl ? (
          <Button variant="ghost" onClick={check}>
            Check
          </Button>
        ) : null}
        <Button variant="ghost" disabled={url.trim() === s.publicUrl} onClick={() => save(url)}>
          Save address
        </Button>
      </RowActions>
      {s.publicUrl && s.tunnel.reached !== null ? (
        <PanelNote>
          <span className={s.tunnel.danger ? 'text-red' : s.tunnel.reached ? 'text-ok' : 'text-amber'}>
            {s.tunnel.reached ? 'Webhooks reach this computer.' : s.tunnel.message}
          </span>
        </PanelNote>
      ) : null}
    </>
  );
}

export function WebhooksTab() {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      rpc.webhooks
        .status()
        .then(setStatus)
        .catch(() => {}),
    [],
  );
  useEffect(() => void load(), [load]);
  useServerEvents((ev) => ['webhook-status', 'settings'].includes(ev.type) && void load());
  if (!status) return <p className="text-dim">Loading…</p>;
  const setup = async (patch: Parameters<typeof rpc.webhooks.setup>[0], ok?: string) => {
    setBusy(true);
    const s = await attempt(() => rpc.webhooks.setup(patch), ok);
    setBusy(false);
    if (s) setStatus(s);
  };
  const check = () => void attempt(() => rpc.webhooks.check()).then((s) => s && setStatus(s));
  const t = status.tunnel;
  const share = status.on ? t.share : 'off';
  const no = (tool: 'cloudflared' | 'tailscale') =>
    t.tools[tool] ? undefined : `${INSTALL[tool].name} isn't installed`;
  return (
    <Sections>
      <Section
        title="Webhooks"
        description="Other services start a routine by sending a webhook to its secret address. Add webhooks on a routine's page."
      >
        <SwitchRow
          checked={status.on}
          onChange={(on) => void setup({ on }, on ? 'Webhooks on' : 'Webhooks off')}
          title="Receive webhooks"
          description="Off: every webhook is refused, the webhooks port is closed and no tunnel runs."
        />
        <Row title="Status" description={statusLine(status)}>
          <Dot tone={status.error ? 'warn' : status.listening ? 'on' : 'off'} />
        </Row>
      </Section>
      <Section
        title="Share webhooks"
        description="How the internet (or your tailnet) reaches the webhooks port. Only webhooks are shared, never the dashboard. Picking one starts it, and it starts again with Athena."
      >
        <Row stack title="Share through" description={share === 'off' ? undefined : SHARE_WORDS[share]}>
          <Segmented<WebhookShare>
            label="Share webhooks"
            value={share}
            onChange={(v) => !busy && void setup({ share: v })}
            options={[
              { value: 'off', label: 'Off' },
              {
                value: 'cloudflare',
                label: 'Cloudflare',
                disabled: !!no('cloudflared'),
                title: no('cloudflared'),
              },
              {
                value: 'tailscale-public',
                label: 'Tailscale, public',
                disabled: !!no('tailscale'),
                title: no('tailscale'),
              },
              {
                value: 'tailscale-tailnet',
                label: 'Tailscale, tailnet only',
                disabled: !!no('tailscale'),
                title: no('tailscale'),
              },
            ]}
          />
        </Row>
        {share !== 'off' ? (
          <TunnelState s={status} check={check} />
        ) : (
          <>
            {!t.tools.cloudflared || !t.tools.tailscale ? (
              <PanelNote>
                {(['cloudflared', 'tailscale'] as const)
                  .filter((tool) => !t.tools[tool])
                  .map((tool) => (
                    <span key={tool} className="mr-4 inline-flex flex-wrap items-center gap-2">
                      {`To use ${INSTALL[tool].name}:`} <Copyable value={INSTALL[tool].cmd} />
                      <a className="text-accent" href={INSTALL[tool].link} target="_blank" rel="noreferrer">
                        download
                      </a>
                    </span>
                  ))}
              </PanelNote>
            ) : null}
            <OwnTunnel s={status} save={(publicUrl) => void setup({ publicUrl }, 'Address saved')} check={check} />
          </>
        )}
      </Section>
      <Section title="Advanced" description="Where webhooks are received, and where the tunnel programs are.">
        <FieldRow
          label="Webhooks port"
          size="sm"
          hint={`Only webhooks are answered here, never the dashboard. Empty: ${status.port}.`}
        >
          <input
            type="number"
            min={1024}
            max={65535}
            placeholder={String(status.port)}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => {
              if (port.trim() === '') return;
              void setup({ port: Number(port) }, 'Port saved').then(() => setPort(''));
            }}
          />
        </FieldRow>
        <ToolPath tool="cloudflared" status={status} save={setup} />
        <ToolPath tool="tailscale" status={status} save={setup} />
      </Section>
    </Sections>
  );
}

function ToolPath({
  tool,
  status,
  save,
}: {
  tool: 'cloudflared' | 'tailscale';
  status: WebhookStatus;
  save: (patch: { toolPaths: { cloudflared?: string; tailscale?: string } }, ok?: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  return (
    <FieldRow
      label={`${INSTALL[tool].name} program`}
      hint={
        status.tunnel.tools[tool]
          ? 'Found. Set a path only to use another copy.'
          : 'Not found. Install it, or give its full path.'
      }
    >
      <input
        value={value}
        placeholder="Found by itself"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value.trim() && void save({ toolPaths: { [tool]: value.trim() } }, 'Saved')}
      />
    </FieldRow>
  );
}
