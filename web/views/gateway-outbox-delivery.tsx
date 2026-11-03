import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, confirmBox } from '../core.ts';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { SelectControl } from '../ui/select.tsx';
import { useServerEvents } from '../ui/react.tsx';
import { GatewayOutboxRecipient } from './gateway-outbox-recipient.tsx';
import type { GatewayOutboxDeliveryReview } from '../../shared/types.ts';

const statuses = { pending: 'Waiting', sending: 'Interrupted send', sent: 'Confirmed', uncertain: 'Delivery uncertain', failed: 'Failed' };
export function GatewayOutboxDeliveryView({ id, instanceId, close, changed, alive }: {
  id: string; instanceId: string; close: () => void; changed: () => void; alive: () => boolean;
}) {
  const root = `/outbox/${encodeURIComponent(id)}/gateway-delivery`;
  const [preview, setPreview] = useState<GatewayOutboxDeliveryReview | null>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(''); const [remoteId, setRemoteId] = useState(''); const [busy, setBusy] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false); const invalid = useRef(false);
  const load = useCallback(async (clear = true) => {
    if (invalid.current) return; const version = ++request.current; if (clear) { setError(''); setNotice(''); }
    try { const value = await GET<GatewayOutboxDeliveryReview>(root); if (mounted.current && request.current === version) setPreview(value); }
    catch (failure) { if (mounted.current && request.current === version) { setPreview(null); setError(failure instanceof Error ? failure.message : 'Delivery receipts could not load. Reload them before continuing.'); } }
  }, [root]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  useServerEvents((event) => {
    if (event.type === 'project') { invalid.current = true; request.current++; setPreview(null); setError('The open project changed. Close this review and open the delivery from its original project.'); }
    else if ((event.type === 'gateway-inbox' && event.instanceId === instanceId) || (event.type === 'gateways' && event.id === instanceId) || (event.type === 'outbox' && event.id === id)) void load(false);
  });
  const picked = preview?.parts.find((part, index) => String(index) === selected && part.canConfirm);
  const act = async (action: 'prepare' | 'confirm' | 'retry' | 'finish') => {
    if (active.current || !mounted.current || !alive() || invalid.current || !preview) return;
    const snapshot = preview; const next = snapshot.nextIndex === undefined ? undefined : snapshot.parts[snapshot.nextIndex];
    const source = `${snapshot.recipient.instanceName}, conversation ${snapshot.recipient.conversationId}${snapshot.recipient.threadId ? `, thread ${snapshot.recipient.threadId}` : ''}, source message ${snapshot.recipient.sourceMessageId}`;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'confirm' && (!picked || !remoteId.trim() || !await confirmBox(`Record part ${Number(selected) + 1} as delivered after checking ${source}? Use its own messaging-app ID. This only records your confirmation. Remaining parts on this post stay held until you explicitly continue them.`, { ok: 'Record confirmed delivery' }))) return;
      if (action === 'retry' && (!snapshot.canRetry || !next || !await confirmBox(`${next.status === 'pending' ? 'Continue' : 'Retry'} part ${snapshot.nextIndex! + 1} and the remaining approved parts for ${source}? ${next.attempts > 0 ? 'The earlier attempt may already have arrived. Retrying can send a duplicate. Check the messaging app first. ' : ''}Confirmed parts will not be resent. The original recipient and text stay fixed. This instance stays paused; enable it in Gateways when ready to send.`, { ok: next.status === 'pending' ? 'Queue remaining parts' : 'Queue retry', danger: next.attempts > 0 }))) return;
      if (action === 'finish' && (!snapshot.canFinish || !await confirmBox(`Finish delivery locally for ${source}? Uncertain parts may already have arrived. Confirmed receipts stay recorded. Remaining parts will never send from this post and this cannot be undone.`, { ok: 'Finish locally', danger: true }))) return;
      if (!mounted.current || !alive() || invalid.current) return;
      if (action === 'finish') await POST(`/outbox/${encodeURIComponent(id)}/gateway-finish`, { revision: snapshot.revision, acknowledgeNoSend: true });
      else {
        const body = action === 'confirm' ? { action, revision: snapshot.revision, index: Number(selected), remoteId: remoteId.trim(), acknowledgeChecked: true }
          : { action, revision: snapshot.revision, index: snapshot.nextIndex, acknowledgeRemaining: true, ...(next && next.attempts > 0 ? { acknowledgePossibleDuplicate: true } : {}) };
        const value = await POST<GatewayOutboxDeliveryReview>(action === 'prepare' ? `${root}/prepare` : root, action === 'prepare' ? undefined : body);
        if (mounted.current) setPreview(value);
      }
      if (mounted.current) {
        setSelected(''); setRemoteId(''); setNotice(action === 'prepare' ? 'Interrupted sends are now uncertain. Check the messaging app before recording what arrived.'
          : action === 'confirm' ? 'Confirmation recorded locally. Remaining parts on this post wait for an explicit continue action.'
            : action === 'retry' ? 'Remaining parts queued. This instance is still paused; enable it in Gateways when ready.' : 'Delivery finished locally. Confirmed receipts and uncertainty are kept.'); changed();
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The review could not save. Reload its current receipts.'); }
    finally { active.current = false; if (mounted.current) { if (!invalid.current) await load(false); if (mounted.current) setBusy(false); } }
  };
  const next = preview?.nextIndex === undefined ? undefined : preview.parts[preview.nextIndex];
  return <><div className="modal-body flex flex-col gap-5">
    <p className="text-dim">Check the messaging app before recording a result or retrying. These controls keep the original recipient, text and confirmed receipts.</p>
    {error && <p role="alert" className="text-red [overflow-wrap:anywhere]">{error}</p>}
    {notice && <p role="status" className="text-dim">{notice}</p>}
    {!preview ? !error && <p role="status" className="text-dim">Loading delivery receipts…</p> : <>
      <GatewayOutboxRecipient value={preview.recipient} />
      {preview.reason && <p role="status" className="text-dim">{preview.reason}</p>}
      {preview.needsPrepare && <div className="flex flex-col items-start gap-2"><p className="text-sm text-dim">Recover the interrupted send locally before reviewing its outcome. This contacts no messaging service.</p><Button size="small" disabled={busy} onClick={() => void act('prepare')}>Recover interrupted receipts</Button></div>}
      <ol className="flex flex-col gap-4 list-none m-0 p-0">
        {preview.parts.map((part, index) => <li key={index} className="border-t border-line pt-4 min-w-0">
          <div className="flex flex-wrap items-center gap-2"><b className="text-sm">Part {index + 1}</b><Pill tone={part.status === 'sent' ? 'ok' : part.status === 'failed' || part.status === 'uncertain' ? 'warn' : 'dim'}>{statuses[part.status]}</Pill></div>
          <details open={preview.nextIndex === index} className="text-sm mt-2"><summary>Show saved text</summary><p tabIndex={0} className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{part.text}</p></details>
          {part.remoteId && <p className="text-sm text-dim mt-2 break-all">Messaging-app ID <code>{part.remoteId}</code></p>}
          {part.confirmedAt !== undefined && <p className="text-sm text-dim mt-2">Confirmed locally {new Date(part.confirmedAt).toLocaleString()}.</p>}
        </li>)}
      </ol>
      {preview.parts.some((part) => part.canConfirm) && <fieldset disabled={busy} className="flex flex-col gap-3 border-t border-line pt-4 min-w-0">
        <legend className="text-sm font-semibold">Record what arrived</legend><p className="text-sm text-dim">Choose an uncertain part you found in the messaging app. Pending or unattempted parts cannot be confirmed.</p>
        <SelectControl aria-label="Outbox part to confirm" value={selected} onChange={(value) => { setSelected(value); setRemoteId(''); }} options={[{ value: '', label: 'Choose an uncertain part' }, ...preview.parts.flatMap((part, index) => part.canConfirm ? [{ value: String(index), label: `Part ${index + 1}` }] : [])]} />
        <label className="flex flex-col gap-2 text-sm">Messaging-app ID<input aria-label="Outbox messaging-app ID" value={remoteId} maxLength={500} onChange={(event) => setRemoteId(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <div><Button size="small" disabled={!picked || !remoteId.trim() || /\s/.test(remoteId.trim())} onClick={() => void act('confirm')}>Record confirmed delivery</Button></div>
      </fieldset>}
      {preview.nextIndex !== undefined && preview.closedAt === undefined && <div className="flex flex-col items-start gap-3 border-t border-line pt-4">
        <b className="text-sm">Remaining approved parts</b><p className="text-sm text-dim">{preview.reviewHeld ? 'Your confirmation did not release the remaining parts. Continue them explicitly when ready.' : 'A retry starts with the first remaining part and keeps the confirmed prefix. Setup or source changes block retry.'}</p>
        {preview.retryReason && <p className="text-sm text-dim">{preview.retryReason}</p>}
        <Button size="small" disabled={busy || !preview.canRetry} onClick={() => void act('retry')}>{next?.status === 'pending' ? 'Continue remaining delivery' : 'Retry remaining delivery'}</Button>
      </div>}
      {preview.canFinish && <div className="border-t border-line pt-4"><Button size="small" variant="danger" disabled={busy} onClick={() => void act('finish')}>Finish locally</Button></div>}
    </>}
    <p className="text-sm text-dim">Confirmation sends nothing. Retry only queues the original approved parts; the instance stays paused. Native work is never started or replayed.</p>
  </div><div className="modal-foot flex flex-wrap gap-2"><ButtonLink size="small" variant="ghost" href={`#/settings?tab=gateways&instance=${encodeURIComponent(instanceId)}`} onClick={close}>Open this gateway</ButtonLink><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload receipts</Button><Button size="small" disabled={busy} onClick={close}>Close</Button></div></>;
}
