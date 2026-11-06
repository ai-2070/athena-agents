import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInstance, GatewayTelegramSetup } from '../../shared/types.ts';

export function TelegramSetupView({ instance, close, edit, pause, changed }: {
  instance: GatewayInstance; close: () => void; edit: () => void; pause: () => Promise<void>; changed: () => Promise<void>;
}) {
  const id = instance.id;
  const [preview, setPreview] = useState<GatewayTelegramSetup | null>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const load = useCallback(async (clear = true) => {
    const version = ++request.current; if (clear) { setError(''); setNotice(''); }
    try { const value = await rpc.gateways.telegram.setup({ id }); if (mounted.current && version === request.current) setPreview(value); }
    catch (failure) { if (mounted.current && version === request.current) { setPreview(null); setError(failure instanceof Error ? failure.message : 'Telegram setup could not load. Reload its saved status.'); } }
  }, [id]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load, instance.enabled]);
  useServerEvents((event) => { if ((event.type === 'gateways' && event.id === instance.id) || (event.type === 'gateway-health' && event.instanceId === instance.id)) void load(false); });
  const act = async (action: 'check' | 'switch' | 'pause') => {
    if (active.current || !mounted.current || (action === 'switch' && !preview?.revision)) return;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'switch' && !await confirmBox(`Switch Telegram bot ${instance.accountId} from the webhook at ${preview!.check?.host || 'the checked host'} to polling? Stop the other bot integration first. Its webhook will be removed, and pending updates will be kept. Pending messages may be handled when you enable this instance. This instance stays paused; saved work and delivery receipts are kept.`, { ok: 'Switch to polling', danger: true })) return;
      if (!mounted.current) return;
      if (action === 'pause') await pause();
      else {
        const value = action === 'switch' ? await rpc.gateways.telegram.switchToPolling({ params: { id }, body: { revision: preview!.revision, acknowledgeStopped: true, acknowledgeKeepUpdates: true } }) : await rpc.gateways.telegram.check({ id });
        if (mounted.current) { setPreview(value); setNotice(action === 'check' ? 'Setup checked. No messages were received or sent.' : 'Polling verified. This instance is still paused; enable it from the gateway list when ready.'); }
      }
      if (mounted.current) await changed();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Setup could not be verified. Check setup before trying another switch.'); }
    finally { if (mounted.current) { await load(false); setBusy(false); } active.current = false; }
  };
  return <Section title={`Telegram setup · ${instance.name}`} description="Check this bot before connecting. Switching from a webhook requires your confirmation and keeps pending updates."
    action={<><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload status</Button><Button size="small" variant="ghost" disabled={busy} onClick={close}>Back to gateways</Button></>}>
    {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
    {notice && <div role="status" className="px-5 py-4 text-dim">{notice}</div>}
    {!preview ? !error && <Row title="Loading saved setup status…" /> : <>
      <Row title="Bot account" description={<span className="break-words [overflow-wrap:anywhere]">Telegram bot <code>{instance.accountId}</code>. The saved token must match this account.</span>}><Button size="small" variant="ghost" disabled={busy} onClick={edit}>Edit instance</Button></Row>
      {preview.reason && <Row title="Before connecting" description={preview.reason} />}
      {instance.enabled ? <Row title="Pause before checking" description="Pausing stops this instance's connection. Native agents keep their controls in Athena."><Button size="small" disabled={busy} onClick={() => void act('pause')}>Pause instance</Button></Row>
        : <Row title="Check Telegram setup" description="Verify the bot token and read its webhook status. This does not start polling, download files or change Telegram setup."><Button size="small" disabled={busy} onClick={() => void act('check')}>{busy ? 'Working…' : 'Check setup'}</Button></Row>}
      {!preview.check ? <Row title="No saved check" description="Check setup to see whether this bot already sends updates to another service." />
        : <Row title={<span className="flex flex-wrap items-center gap-2"><span>Last setup check</span><Pill tone={preview.check.webhook ? 'warn' : 'ok'}>{preview.check.webhook ? 'Webhook found' : 'No webhook'}</Pill></span>}
          description={<><span className="block">Checked {new Date(preview.check.at).toLocaleString()}.</span>{preview.check.host && <span className="mt-1 block break-words [overflow-wrap:anywhere]">Webhook host <code>{preview.check.host}</code>. URL paths and secrets stay private.</span>}<span className="mt-1 block">{preview.check.pendingUpdates.toLocaleString()} updates were waiting at this check. Telegram's queue can change.</span>{!preview.check.webhook && <span className="mt-1 block">No webhook was registered at this check. Athena checks again when connecting.</span>}</>} />}
      {preview.attempt && <Row title={<span className="flex flex-wrap items-center gap-2"><span>Last switch attempt</span><Pill tone={preview.attempt.state === 'confirmed' ? 'ok' : 'warn'}>{preview.attempt.state === 'confirmed' ? 'Polling verified' : 'Needs check'}</Pill></span>}
        description={<>Recorded {new Date(preview.attempt.at).toLocaleString()}. {preview.attempt.state === 'confirmed' ? 'A setup check verified that no webhook remained.' : 'The remote outcome is unconfirmed. Check setup before enabling or confirming another switch; Athena will not retry it automatically.'}<span className="mt-1 block">{preview.switches} saved switch {preview.switches === 1 ? 'attempt' : 'attempts'} kept.</span></>} />}
      {preview.revision && <Row title="Switch this bot to polling" description="Stop the service using this webhook first. Switching removes its webhook and keeps pending updates. Athena stays paused until you enable it; pending messages then follow the instance's sender and conversation rules.">
        <Button size="small" variant="danger" disabled={busy || instance.enabled} onClick={() => void act('switch')}>Switch to polling</Button>
      </Row>}
    </>}
    <PanelNote>Connecting never removes an existing webhook automatically. Setup checks and switching do not receive messages, send replies, replay model work or change saved inbox receipts. Telegram provides no atomic check-and-switch operation; stop the previous integration before confirming.</PanelNote>
  </Section>;
}
