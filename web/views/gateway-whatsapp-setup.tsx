import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, confirmBox } from '../core.ts';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInstance, GatewayWhatsAppCheck, GatewayWhatsAppRecovery, GatewayWhatsAppSetup } from '../../shared/types.ts';

export function WhatsAppSetupView({ instance, close, changed, pause, edit }: {
  instance: GatewayInstance & { credentials: Record<string, boolean> };
  close: () => void; changed: () => Promise<void>; pause: () => Promise<void>; edit: () => void;
}) {
  const root = `/gateways/${encodeURIComponent(instance.id)}`;
  const [setup, setSetup] = useState<GatewayWhatsAppSetup | null>(null); const [recovery, setRecovery] = useState<GatewayWhatsAppRecovery | null>(null);
  const [check, setCheck] = useState<GatewayWhatsAppCheck | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState(''); const [business, setBusiness] = useState(''); const [code, setCode] = useState('');
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const load = useCallback(async (clearError = true) => {
    const version = ++request.current;
    if (clearError) { setError(''); setCheck(null); }
    try {
      const [saved, held] = await Promise.all([GET<GatewayWhatsAppSetup>(`${root}/whatsapp-setup`), GET<GatewayWhatsAppRecovery>(`${root}/whatsapp-recovery`)]);
      if (mounted.current && version === request.current) { setSetup(saved); setRecovery(held); }
    } catch (failure) { if (mounted.current && version === request.current) { setSetup(null); setError(failure instanceof Error ? failure.message : 'Setup could not load. Reload it before continuing.'); } }
  }, [root]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load, instance.enabled]);
  useServerEvents((event) => {
    if ((event.type === 'gateways' && event.id === instance.id) || (event.type === 'gateway-inbox' && event.instanceId === instance.id)) { setCheck(null); void load(false); }
  });
  const run = async (work: () => Promise<void>) => {
    if (active.current || !mounted.current) return;
    active.current = true; setBusy(true); setError(''); setCheck(null);
    try { await work(); if (mounted.current) await changed(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Setup could not be completed. Reload its saved status before trying again.'); }
    finally { if (mounted.current) await load(false); if (mounted.current) setBusy(false); active.current = false; }
  };
  const pair = () => run(async () => {
    if (!await confirmBox('Pair this relay with the saved business phone? This starts at the relay’s current saved position. Review any previous installation first. This instance will stay paused.', { ok: 'Pair relay' }) || !mounted.current) return;
    const body = { origin: origin.trim(), businessAccountId: business.trim(), code: code.trim(), acknowledgeStart: true }; setCode('');
    await POST(`${root}/whatsapp-pairing`, body);
  });
  const credentialsReady = instance.credentials.accessToken && instance.credentials.signingSecret && instance.credentials.relayKey;
  return <Section title={`WhatsApp setup · ${instance.name}`} description="Pair one relay with this business phone, then check its saved account and connection. Setup leaves the instance paused."
    action={<><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload setup</Button><Button size="small" variant="ghost" disabled={busy} onClick={close}>Close setup</Button></>}>
    {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
    {instance.enabled && <Row title="Pause before changing setup" description="Pairing, checks and recovery require a paused instance."><Button size="small" disabled={busy} onClick={() => void run(pause)}>Pause instance</Button></Row>}
    {!setup ? !error && <Row title="Loading saved setup…" /> : setup.pending?.phase === 'requesting' ? <>
      <Row title="Pairing outcome unknown" description="Do not reuse the code. The relay may already have accepted it." />
      <PanelNote>Revoke the pairing at your relay before continuing. Revocation drops queued messages. Athena cannot revoke it for you; check the relay and any previous installation first.</PanelNote>
      <RowActions><Button disabled={busy || instance.enabled} onClick={() => void run(async () => {
        const revision = setup.pending!.revision;
        if (!await confirmBox('Have you revoked this pairing at the relay and reviewed its queue loss? This only clears the unknown local attempt. It does not revoke the relay. Use a new pairing code afterward.', { ok: 'I revoked the pairing' }) || !mounted.current) return;
        await POST(`${root}/whatsapp-pairing/review`, { revision, acknowledgeRemoteRevoked: true });
      })}>Review unknown pairing</Button></RowActions>
    </> : setup.pending?.phase === 'received' ? <>
      <Row title="Pairing key saved" description="Finish saving the local binding. This keeps the saved key and makes no new pairing request." />
      <RowActions><Button disabled={busy || instance.enabled} onClick={() => void run(async () => { await POST(`${root}/whatsapp-pairing/finish`, { revision: setup.pending!.revision }); })}>Finish saved pairing</Button></RowActions>
    </> : !setup.paired ? <form onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <fieldset disabled={busy || instance.enabled} className="m-0 min-w-0 border-0 p-0">
        <Row title="Pair your relay" description="Deploy one relay per business phone and create a short-lived pairing code on that relay. The code works once; Athena saves the returned key privately." />
        <FieldRow label="Relay HTTPS address" hint="The address only, for example https://your-relay.example. No path, query or login details."><input aria-label="Relay HTTPS address" type="url" required maxLength={2048} autoComplete="off" value={origin} onChange={(event) => setOrigin(event.target.value)} /></FieldRow>
        <FieldRow label="Business account ID" hint="The numeric Meta business account ID configured on this relay."><input aria-label="Business account ID" required inputMode="numeric" pattern="[1-9][0-9]{0,29}" value={business} onChange={(event) => setBusiness(event.target.value)} /></FieldRow>
        <FieldRow label="Pairing code" hint="Paste the new 64-character code. It is cleared after submission and is never saved."><input aria-label="Pairing code" type="password" required pattern="[a-f0-9]{64}" maxLength={64} autoComplete="new-password" value={code} onChange={(event) => setCode(event.target.value)} /></FieldRow>
        <RowActions><Button type="submit">{busy ? 'Pairing…' : 'Pair relay'}</Button></RowActions>
      </fieldset>
    </form> : <>
      <Row title={<span className="flex flex-wrap items-center gap-2">Relay paired <Pill tone={setup.recoveryRequired ? 'warn' : 'ok'}>{setup.recoveryRequired ? 'Needs review' : 'Saved'}</Pill></span>} description="The pull key stays on this computer. Pairing does not verify the Meta access token or enable the connection." />
      {!credentialsReady && <Row title="Complete the account credentials" description="Save the access token and Meta app secret in the instance editor before checking setup."><Button size="small" variant="ghost" disabled={busy} onClick={edit}>Edit instance</Button></Row>}
      <Row title="Check setup" description="Read-only account and relay checks. No messages are claimed or acknowledged, no files are downloaded and no work or replies are started."><Button size="small" disabled={busy || instance.enabled || !credentialsReady} onClick={() => void run(async () => { const result = await POST<GatewayWhatsAppCheck>(`${root}/whatsapp-setup/check`); if (mounted.current) setCheck(result); })}>{busy ? 'Checking…' : 'Check setup'}</Button></Row>
      {check && <Row title="Setup check complete" description={<span role="status">Account verified. {check.relay === 'ready' ? 'The saved relay is ready for a connection.' : check.relay === 'acknowledgement-pending' ? 'The relay is reachable; an exact saved acknowledgement still needs recovery on connection.' : 'The relay needs recovery review.'} Checked {new Date(check.checkedAt).toLocaleString()}. This result does not enable the instance.</span>} />}
      {recovery?.reason && recovery.reason !== 'gap' && <Row title="Restore the saved pairing or receipt" description="This hold cannot be cleared by a retention-gap review. Keep the saved work and pairing; restore them before reconnecting." />}
      {(!recovery?.reason || recovery.reason === 'gap') && <>
        <Row title="Relay gap review" description={recovery?.gap ? `Observed ${new Date(recovery.gap.at).toLocaleString()}. Ask the relay operator to review that exact gap before accepting its loss here.` : 'If messages expired while this computer was offline, check and save the relay’s current lost range first.'}>
          <Button size="small" variant="ghost" disabled={busy || instance.enabled} onClick={() => void run(async () => { await POST(`${root}/whatsapp-recovery/inspect`); })}>Check relay gap</Button>
        </Row>
        {recovery?.gap && <RowActions><Button disabled={busy || instance.enabled} onClick={() => void run(async () => {
          const revision = recovery.gap!.revision;
          if (!await confirmBox('Has the relay operator reviewed this exact gap? Missing messages cannot be recovered here. Saved work, files and delivery receipts stay held; this review only restores intake and keeps the instance paused.', { ok: 'Accept reviewed gap' }) || !mounted.current) return;
          await POST(`${root}/whatsapp-recovery`, { revision, acknowledgeGap: true });
        })}>Review gap locally</Button></RowActions>}
      </>}
    </>}
    <RowActions><ButtonLink variant="ghost" size="small" href="https://github.com/ai-2070/athena-agents/blob/main/relay/whatsapp/README.md" target="_blank" rel="noopener noreferrer">Relay setup instructions</ButtonLink></RowActions>
    <PanelNote>WhatsApp receiving and sending remain disabled while support is in development. Checks are current observations, not lasting permission to run or send. Approvals stay in Athena.</PanelNote>
  </Section>;
}
