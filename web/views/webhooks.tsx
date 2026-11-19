// Settings › Webhooks: whether webhooks are received, on which port, and where the internet reaches them. Each
// webhook is made on the routine it starts.
import { useCallback, useEffect, useState } from 'react';
import { attempt } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section, Sections, SwitchRow } from '../ui/controls.tsx';
import { Dot } from '../ui/marks.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { WebhookStatus } from '../../shared/types.ts';

/** The listener's state in a few words. */
export function statusLine(s: WebhookStatus): string {
  if (s.error) return s.error;
  if (!s.on) return 'Off: webhooks are refused.';
  if (s.listening) return `Listening on 127.0.0.1:${s.port}, for webhooks only.`;
  return 'Starts when a webhook is on.';
}

export function WebhooksTab() {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [port, setPort] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const load = useCallback(
    () =>
      rpc.webhooks.status().then((s) => {
        setStatus(s);
        return s;
      }),
    [],
  );
  useEffect(() => {
    void load()
      .then((s) => setPublicUrl(s.publicUrl))
      .catch(() => {});
  }, [load]);
  useServerEvents((ev) => ['webhook-status', 'settings'].includes(ev.type) && void load().catch(() => {}));
  if (!status) return <p className="text-dim">Loading…</p>;
  const setup = (patch: { on?: boolean; port?: number | null; publicUrl?: string }, ok: string) =>
    attempt(() => rpc.webhooks.setup(patch), ok).then((s) => s && setStatus(s));
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
          description="Off: every webhook is refused, and the webhooks port is closed."
        />
        <Row title="Status" description={statusLine(status)}>
          <Dot tone={status.error ? 'warn' : status.listening ? 'on' : 'off'} />
        </Row>
        <FieldRow
          label="Port"
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
        <FieldRow
          label="Public address"
          hint="Where the internet reaches the webhooks port, such as your tunnel's https address. Empty: this computer's address only."
        >
          <input
            value={publicUrl}
            placeholder="https://…"
            spellCheck={false}
            onChange={(e) => setPublicUrl(e.target.value)}
          />
        </FieldRow>
        <RowActions>
          <Button
            variant="ghost"
            disabled={publicUrl.trim() === status.publicUrl}
            onClick={() => void setup({ publicUrl }, 'Public address saved')}
          >
            Save address
          </Button>
        </RowActions>
        <PanelNote>
          Never point a tunnel at the dashboard's port: anyone who reaches it can use the whole app. Point it at the
          webhooks port above.
        </PanelNote>
      </Section>
    </Sections>
  );
}
