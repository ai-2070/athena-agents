import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, confirmBox } from '../core.ts';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInstance, GatewayWhatsAppCheck, GatewayWhatsAppRecovery, GatewayWhatsAppReplacement, GatewayWhatsAppSetup } from '../../shared/types.ts';

export function WhatsAppSetupView({ instance, close, changed, pause, edit }: {
  instance: GatewayInstance & { credentials: Record<string, boolean> };
  close: () => void; changed: () => Promise<void>; pause: () => Promise<void>; edit: () => void;
}) {
  const root = `/gateways/${encodeURIComponent(instance.id)}`;
  const [setup, setSetup] = useState<GatewayWhatsAppSetup | null>(null); const [recovery, setRecovery] = useState<GatewayWhatsAppRecovery | null>(null);
  const [check, setCheck] = useState<GatewayWhatsAppCheck | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false); const [restored, setRestored] = useState(false);
  const [replacement, setReplacement] = useState<GatewayWhatsAppReplacement | null>(null); const [replacing, setReplacing] = useState(false);
  const [origin, setOrigin] = useState(''); const [business, setBusiness] = useState(''); const [code, setCode] = useState('');
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const load = useCallback(async (clearError = true) => {
    const version = ++request.current;
    if (clearError) { setError(''); setCheck(null); setRestored(false); }
    try {
      const [saved, held, available] = await Promise.all([GET<GatewayWhatsAppSetup>(`${root}/whatsapp-setup`), GET<GatewayWhatsAppRecovery>(`${root}/whatsapp-recovery`), GET<GatewayWhatsAppReplacement>(`${root}/whatsapp-replacement`)]);
      if (mounted.current && version === request.current) { setSetup(saved); setRecovery(held); setReplacement(available); if (saved.pending) setReplacing(false); }
    } catch (failure) { if (mounted.current && version === request.current) { setSetup(null); setError(failure instanceof Error ? failure.message : 'Setup could not load. Reload it before continuing.'); } }
  }, [root]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load, instance.enabled]);
  useServerEvents((event) => {
    if ((event.type === 'gateways' && event.id === instance.id) || (event.type === 'gateway-inbox' && event.instanceId === instance.id)) { setCheck(null); void load(false); }
  });
  const run = async (work: () => Promise<void>, checking = false) => {
    if (active.current || !mounted.current) return;
    active.current = true; setBusy(true); setChecking(checking); setError(''); setCheck(null); setRestored(false);
    try { await work(); if (mounted.current) await changed(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Setup could not be completed. Reload its saved status before trying again.'); }
    finally { if (mounted.current) await load(false); if (mounted.current) { setBusy(false); setChecking(false); } active.current = false; }
  };
  const pair = () => run(async () => {
    const replace = replacing; const revision = replacement?.revision;
    if (!await confirmBox(replace ? 'Have you revoked or permanently stopped the old relay and reviewed its lost messages? The new relay must use the same business account and phone. Old requests and deliveries stay held; fresh messages start separate conversations. The new key will be saved for a separate finish review. This instance stays paused.' : 'Pair this relay with the saved business phone? This starts at the relay’s current saved position. Review any previous installation first. This instance will stay paused.', { ok: replace ? 'Pair replacement' : 'Pair relay' }) || !mounted.current) return;
    const body = { origin: origin.trim(), businessAccountId: business.trim(), code: code.trim(), ...(replace ? { revision, acknowledgePreviousStopped: true, acknowledgeLoss: true } : { acknowledgeStart: true }) }; setCode('');
    await POST(`${root}/whatsapp-pairing${replace ? '/replace' : ''}`, body);
  });
  const credentialsReady = instance.credentials.accessToken && instance.credentials.signingSecret && instance.credentials.relayKey;
  return <Section title={`WhatsApp setup · ${instance.name}`} description="Pair one relay with this business phone, then check its saved account and connection. Setup leaves the instance paused."
    action={<><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload setup</Button><Button size="small" variant="ghost" disabled={busy} onClick={close}>Close setup</Button></>}>
    {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
    {instance.enabled && <Row title="Pause before changing setup" description="Pairing, checks and recovery require a paused instance."><Button size="small" disabled={busy} onClick={() => void run(pause)}>Pause instance</Button></Row>}
    {!setup ? !error && <Row title="Loading saved setup…" /> : setup.pending?.phase === 'requesting' ? <>
      <Row title="Pairing outcome unknown" description="Do not reuse the code. The relay may already have accepted it." />
      <PanelNote>Revoke the {setup.pending.replacement ? 'new relay pairing' : 'pairing at your relay'} before continuing. Revocation drops queued messages. Athena cannot revoke it for you; check the relay and any previous installation first.{setup.pending.replacement && ' The old receipts and work stay saved; clearing this attempt does not restore the old pull key.'}</PanelNote>
      <RowActions><Button disabled={busy || instance.enabled} onClick={() => void run(async () => {
        const revision = setup.pending!.revision;
        if (!await confirmBox('Have you revoked this pairing at the relay and reviewed its queue loss? This only clears the unknown local attempt. It does not revoke the relay. Use a new pairing code afterward.', { ok: 'I revoked the pairing' }) || !mounted.current) return;
        await POST(`${root}/whatsapp-pairing/review`, { revision, acknowledgeRemoteRevoked: true });
      })}>Review unknown pairing</Button></RowActions>
    </> : setup.pending?.phase === 'received' ? <>
      <Row title={setup.pending.replacement ? 'Replacement key saved' : 'Pairing key saved'} description={setup.pending.replacement ? 'Review the current saved work before finishing. Finishing archives old receipts and keeps them blocked from the new relay. The instance and phone keep their duplicate protection.' : 'Finish saving the local binding. This keeps the saved key and makes no new pairing request.'} />
      <RowActions><Button disabled={busy || instance.enabled} onClick={() => void run(async () => {
        const pending = setup.pending!;
        if (pending.replacement && (!await confirmBox('Finish replacing this relay? Any messages left on the old relay may be lost. Old work, files and delivery receipts stay held. Only fresh signed messages can start new conversations; ask senders to message again after finishing. This keeps the instance paused.', { ok: 'Finish replacement' }) || !mounted.current)) return;
        await POST(`${root}/whatsapp-pairing/finish`, { revision: pending.revision, ...(pending.replacement ? { acknowledgeLoss: true } : {}) });
      })}>{setup.pending.replacement ? 'Finish replacement' : 'Finish saved pairing'}</Button></RowActions>
    </> : !setup.paired || replacing ? <form onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <fieldset disabled={busy || instance.enabled} className="m-0 min-w-0 border-0 p-0">
        <Row title={replacing ? 'Pair a replacement relay' : 'Pair your relay'} description={replacing ? 'Revoke or permanently stop the old relay first and review its message loss. Create a new one-use code on the replacement for the same business account and phone. Saved work and receipts stay held.' : 'Deploy one relay per business phone and create a short-lived pairing code on that relay. The code works once; Athena saves the returned key privately.'} />
        <FieldRow label="Relay HTTPS address" hint="The address only, for example https://your-relay.example. No path, query or login details."><input aria-label="Relay HTTPS address" type="url" required maxLength={2048} autoComplete="off" value={origin} onChange={(event) => setOrigin(event.target.value)} /></FieldRow>
        <FieldRow label="Business account ID" hint="The numeric Meta business account ID configured on this relay."><input aria-label="Business account ID" required inputMode="numeric" pattern="[1-9][0-9]{0,29}" value={business} onChange={(event) => setBusiness(event.target.value)} /></FieldRow>
        <FieldRow label="Pairing code" hint="Paste the new 64-character code. It is cleared after submission and is never saved."><input aria-label="Pairing code" type="password" required pattern="[a-f0-9]{64}" maxLength={64} autoComplete="new-password" value={code} onChange={(event) => setCode(event.target.value)} /></FieldRow>
        <RowActions>{replacing && <Button type="button" variant="ghost" onClick={() => { setReplacing(false); setCode(''); }}>Cancel replacement</Button>}<Button type="submit">{busy ? 'Pairing…' : replacing ? 'Pair replacement' : 'Pair relay'}</Button></RowActions>
      </fieldset>
    </form> : <>
      <Row title={<span className="flex flex-wrap items-center gap-2">Relay paired <Pill tone={setup.recoveryRequired ? 'warn' : 'ok'}>{setup.recoveryRequired ? 'Needs review' : 'Saved'}</Pill></span>} description="The pull key stays on this computer. Pairing does not verify the Meta access token or enable the connection." />
      {!credentialsReady && <Row title="Complete the account credentials" description="Save the access token and Meta app secret in the instance editor before checking setup."><Button size="small" variant="ghost" disabled={busy} onClick={edit}>Edit instance</Button></Row>}
      <Row title="Check setup" description="Read-only account and relay checks. No messages are claimed or acknowledged, no files are downloaded and no work or replies are started."><Button size="small" disabled={busy || instance.enabled || !credentialsReady} onClick={() => void run(async () => { const result = await POST<GatewayWhatsAppCheck>(`${root}/whatsapp-setup/check`); if (mounted.current) setCheck(result); }, true)}>{checking ? 'Checking…' : 'Check setup'}</Button></Row>
      {check && <Row title="Setup check complete" description={<span role="status">Account verified. {check.relay === 'ready' ? 'The saved relay is ready for a connection.' : check.relay === 'acknowledgement-pending' ? 'The relay is reachable; an exact saved acknowledgement still needs recovery on connection.' : 'The relay needs recovery review.'} Checked {new Date(check.checkedAt).toLocaleString()}. This result does not enable the instance.</span>} />}
      {recovery?.reason && recovery.reason !== 'gap' && <>
        <Row title="Restore the saved relay" description="Restore the original relay installation and its saved data at the same address, then check it here. A replacement relay, changed account or missing receipts cannot pass this check. Saved work stays held.">
          {recovery.restoration && <Button size="small" disabled={busy || instance.enabled} onClick={() => void run(async () => {
            const revision = recovery.restoration!.revision;
            if (!await confirmBox('Have you restored the original relay and its saved data? Only the saved installation, phone, account and receipt position can clear this connection hold. Saved work and delivery receipts stay held. This does not pair a new relay or enable WhatsApp.', { ok: 'Check restored relay' }) || !mounted.current) return;
            await POST(`${root}/whatsapp-recovery/restore`, { revision, acknowledgeRestore: true });
            if (mounted.current) setRestored(true);
          })}>Check restored relay</Button>}
        </Row>
        {recovery.restoration && <PanelNote>Connection held since {new Date(recovery.restoration.at).toLocaleString()}. This check reads relay status only. Signed messages and exact acknowledgements are verified again on connection.</PanelNote>}
      </>}
      {restored && !recovery?.reason && <Row title="Connection hold cleared" description={<span role="status">The original relay matches its saved binding. The instance stays paused; saved work, files and delivery receipts still need their own review.</span>} />}
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
      <Row title="Replace a lost relay" description={replacement?.revision ? 'Use a new pairing when the original relay cannot be restored. Keep the same business account and phone; revoke or permanently stop the old relay and review its queue loss first. Old work remains separate.' : 'Replacement is unavailable until this pairing is saved or its bounded history has room.'}>
        <Button size="small" variant="ghost" disabled={busy || instance.enabled || !replacement?.revision} onClick={() => { setOrigin(''); setBusiness(''); setCode(''); setReplacing(true); }}>Replace relay</Button>
      </Row>
      {Boolean(replacement?.retired) && <PanelNote>{replacement!.retired} earlier relay {replacement!.retired === 1 ? 'binding is' : 'bindings are'} archived. Their requests and receipts stay in the inbox; they cannot run or send through this relay.</PanelNote>}
    </>}
    <RowActions><ButtonLink variant="ghost" size="small" href="https://github.com/ai-2070/athena-agents/blob/main/relay/whatsapp/README.md" target="_blank" rel="noopener noreferrer">Relay setup instructions</ButtonLink></RowActions>
    <PanelNote>WhatsApp receiving and sending remain disabled while support is in development. Checks are current observations, not lasting permission to run or send. Approvals stay in Athena.</PanelNote>
  </Section>;
}
