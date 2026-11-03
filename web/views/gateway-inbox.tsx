import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, confirmBox } from '../core.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { SelectControl } from '../ui/select.tsx';
import { useServerEvents } from '../ui/react.tsx';
import { GatewayDeliveryReviewView } from './gateway-delivery-review.tsx';
import type { GatewayInboxEvent, GatewayInstance, GatewayOutgoingFile, GatewayRequestReview } from '../../shared/types.ts';
import { gatewayAlbumCandidates, gatewayCleanupCandidates, gatewayNeedsReview, gatewayPlatformAvailable, gatewayRequestUnstarted } from '../../shared/gateways.ts';
export { gatewayNeedsReview } from '../../shared/gateways.ts';

const message = (error: unknown) => error instanceof Error ? error.message : 'Could not update this inbox. Try again.';
const unresolved = (status: string) => status === 'failed' || status === 'uncertain';
const deliveryLabel = (status: GatewayOutgoingFile['status'] | 'saved' | 'transferring') => ({ pending: 'Waiting', sending: 'Sending', sent: 'Sent', uncertain: 'Delivery uncertain', failed: 'Needs review', skipped: 'Skipped', saved: 'Saved', transferring: 'Downloading' })[status];
export function gatewayMessageStatus(event: GatewayInboxEvent): string {
  if (event.dismissed) return 'Dismissed';
  if (event.deliveryFinished) return 'Finished locally';
  if (event.album && event.album.leaderId !== event.id) return 'Grouped in album';
  if (event.reply?.parts.some((part) => part.status === 'uncertain') || event.outgoing?.some((file) => file.status === 'uncertain')) return 'Delivery uncertain';
  if (gatewayNeedsReview(event)) return 'Needs review';
  if (event.status === 'queued') return 'Queued';
  if (event.status === 'waiting-files') return 'Saving attachments';
  if (event.status === 'running') return 'Working';
  if (event.reply?.parts.some((part) => part.status !== 'sent') || event.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status))) return 'Delivering';
  if (!event.reply) return 'Completed locally';
  return event.outgoing?.some((file) => file.status === 'skipped') ? 'Completed with skipped files' : 'Delivered';
}

export function GatewayInboxView({ instance, close }: { instance: GatewayInstance; close: () => void }) {
  const [events, setEvents] = useState<GatewayInboxEvent[] | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('review'); const [limit, setLimit] = useState(25);
  const [age, setAge] = useState('30'); const [notice, setNotice] = useState('');
  const [deliveryId, setDeliveryId] = useState('');
  const mounted = useRef(false); const request = useRef(0); const actionPending = useRef(false);
  const root = `/gateways/${encodeURIComponent(instance.id)}/inbox`;
  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const response = await GET<{ events: GatewayInboxEvent[] }>(root);
      if (mounted.current && request.current === version) { setEvents(response.events); setError(''); }
    } catch (failure) { if (mounted.current && request.current === version) setError(message(failure)); }
  }, [root]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  useServerEvents((event) => { if (event.type === 'gateway-inbox' && event.instanceId === instance.id) void load(); });
  const act = async (suffix: string, body?: unknown): Promise<boolean> => {
    if (actionPending.current || !mounted.current) return false;
    actionPending.current = true;
    setBusy(true); setError('');
    try { await POST(`${root}/${suffix}`, body); if (mounted.current) await load(); return true; }
    catch (failure) { if (mounted.current) setError(message(failure)); return false; }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  };
  const dismiss = async (eventId: string) => {
    if (actionPending.current || !mounted.current) return;
    actionPending.current = true; setBusy(true); setError('');
    try {
      const preview = await GET<GatewayRequestReview>(`${root}/${encodeURIComponent(eventId)}/review`);
      if (!mounted.current) return;
      if (!preview.canDismiss) { setError(preview.reason); return; }
      if (!await confirmBox('Dismiss this request without starting an assignment or sending a reply? Its saved text and files stay in Athena. If the work is still needed, ask the sender to send a new message. Later messages can continue once earlier holds are resolved and the gateway is enabled.', { ok: 'Dismiss request' }) || !mounted.current) return;
      await POST(`${root}/${encodeURIComponent(eventId)}/dismiss`, { revision: preview.revision, acknowledgeDismiss: true });
      if (mounted.current) { setNotice('Request dismissed. Its saved text and files stay in Athena.'); await load(); }
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  };
  const ordered = [...(events || [])].sort((a, b) => b.sequence - a.sequence);
  const shown = filter === 'review' ? ordered.filter(gatewayNeedsReview) : ordered;
  const connected = instance.enabled && gatewayPlatformAvailable(instance.platform);
  const cutoff = () => age === 'all' ? Date.now() : Date.now() - Number(age) * 86400000;
  const eligible = gatewayCleanupCandidates(events || [], cutoff());
  const cleanup = async () => {
    const before = cutoff(); const selected = gatewayCleanupCandidates(events || [], before).map((event) => event.id);
    if (!selected.length || busy) return;
    if (!await confirmBox(`Remove ${selected.length} completed or dismissed inbox receipt${selected.length === 1 ? '' : 's'}? Their message text, replies and file receipts will be removed from this inbox and cannot be restored here. Native chats and project files stay. Compact replay markers and byte reservations stay; active or unresolved conversations are kept.`, { ok: 'Remove receipts', danger: true })) return;
    if (await act('cleanup', { before, eventIds: selected }) && mounted.current) setNotice(`Removed ${selected.length} resolved receipt${selected.length === 1 ? '' : 's'}. Native chats and project files were kept.`);
  };
  if (deliveryId) return <GatewayDeliveryReviewView instance={instance} eventId={deliveryId} close={() => setDeliveryId('')} changed={load} />;
  return <Section title={`Inbox · ${instance.name}`} description="Review accepted messages and individual delivery results. Earlier unresolved work holds later messages in the same conversation."
    action={<><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload inbox</Button><Button size="small" variant="ghost" disabled={busy} onClick={close}>Close inbox</Button></>}>
    <Row title="Messages" description={events ? `${events.length} saved · ${events.filter(gatewayNeedsReview).length} need review` : 'Loading inbox…'}>
      <SelectControl aria-label="Inbox filter" value={filter} options={[{ value: 'review', label: 'Needs review' }, { value: 'all', label: 'All messages' }]} onChange={(value) => { setFilter(value); setLimit(25); }} />
    </Row>
    {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
    {notice && <div role="status" className="px-5 py-4 text-dim">{notice}</div>}
    {!events && !error && <Row title="Loading messages…" />}
    {events && !shown.length && <Row title={!events.length ? 'No saved messages' : 'No messages need review'} description={!events.length ? 'Messages from allowed senders appear here after they are saved.' : 'Choose All messages to see queued work, completed replies and confirmed files.'} />}
    {!connected && <PanelNote>This instance is paused or unavailable. Completed answers can have their delivery reviewed while paused. Enable its connection before retrying deliveries or selecting files.</PanelNote>}
    {shown.slice(0, limit).map((event) => {
      const candidates = gatewayAlbumCandidates(events || [], event);
      const album = event.album?.memberIds?.map((id) => events?.find((item) => item.id === id)).filter((item) => item !== undefined) ?? [];
      const leader = events?.find((item) => item.id === event.album?.leaderId);
      return <InboxMessage key={event.id} event={event} busy={busy} connected={connected} paused={!instance.enabled} act={act} dismiss={dismiss} reviewDelivery={setDeliveryId}
        candidates={candidates[0]?.id === event.id ? candidates : []} album={album} leader={leader}
        canSelect={!event.deliveryFinished && !event.outgoing && Boolean(event.dispatch) && ['running', 'done'].includes(event.status) && !events?.some((later) => later.bindingId === event.bindingId && later.sequence > event.sequence && later.dispatch)} />;
    })}
    {shown.length > limit && <RowActions><Button size="small" variant="ghost" onClick={() => setLimit((before) => before + 25)}>Show 25 more</Button></RowActions>}
    {events && <Row title="Clean resolved receipts" description={`${eligible.length} eligible. Completed and dismissed requests can be removed; unresolved conversations stay. This only removes inbox receipts, not native chats or project files.`} stack>
      <div className="flex flex-wrap items-center gap-2">
        <SelectControl aria-label="Receipt cleanup age" value={age} options={[{ value: '7', label: 'Received over 7 days ago' }, { value: '30', label: 'Received over 30 days ago' }, { value: '90', label: 'Received over 90 days ago' }, { value: 'all', label: 'All resolved receipts' }]} onChange={setAge} />
        <Button size="small" variant="danger" disabled={busy || !eligible.length} onClick={() => void cleanup()}>Remove resolved receipts</Button>
      </div>
    </Row>}
    <PanelNote>Confirmed deliveries are kept. Check the messaging app before retrying an uncertain send; it may already have arrived. These controls never replay model work. Approvals stay in Athena.</PanelNote>
  </Section>;
}

function InboxMessage({ event, busy, connected, paused, canSelect, act, dismiss, reviewDelivery, candidates, album, leader }: {
  event: GatewayInboxEvent; busy: boolean; connected: boolean; paused: boolean; canSelect: boolean;
  candidates: GatewayInboxEvent[]; album: GatewayInboxEvent[]; leader?: GatewayInboxEvent;
  act: (suffix: string, body?: unknown) => Promise<boolean>;
  dismiss: (eventId: string) => Promise<void>;
  reviewDelivery: (eventId: string) => void;
}) {
  const [paths, setPaths] = useState(''); const [selecting, setSelecting] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = encodeURIComponent(event.id);
  const status = gatewayMessageStatus(event);
  const firstReply = event.reply?.parts.find((part) => part.status !== 'sent');
  const group = async () => {
    const ids = candidates.map((item) => item.id);
    if (!await confirmBox(`Start one assignment with these ${ids.length} album messages: ${candidates.map((item) => item.input.sourceMessageId).join(', ')}? Telegram has no album completion marker. Check Telegram for all parts before continuing. All saved files and captions will be included. Later parts will be held for review.`, { ok: 'Group album and start' })) return;
    await act(`${base}/group-album`, { eventIds: ids });
  };
  const retry = async (suffix: string, uncertain: boolean) => {
    if (uncertain && !await confirmBox(`Check ${({ telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' })[event.input.platform]} chat ${event.input.conversationId} for message ${event.input.sourceMessageId} first. This delivery may already have arrived. Retrying can send a duplicate; confirmed parts will be kept.`, { ok: 'Retry delivery' })) return;
    await act(`${base}/${suffix}`);
  };
  const skip = async (index: number, uncertain: boolean) => {
    if (!await confirmBox(uncertain ? 'Stop trying to send this file? It may already have arrived. Skipping cannot undo a remote delivery.' : 'Skip this file? It will stay in Athena and will not be sent.', { ok: 'Skip file' })) return;
    await act(`${base}/files/${index}/skip`);
  };
  const select = async () => {
    setSelecting(true);
    try {
      const selected = paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (await act(`${base}/files`, { paths: selected }) && mounted.current) setPaths('');
    } finally { if (mounted.current) setSelecting(false); }
  };
  const selectedPaths = paths.split(/\r?\n/).filter((value) => value.trim());
  return <details className="group px-5 py-4">
    <summary className="cursor-pointer rounded-ctl text-[14px] break-words text-ink focus-visible:outline-2 focus-visible:outline-accent">
      <span className="ml-1 font-medium">{event.input.actor.label}</span>{' '}<Pill tone={gatewayNeedsReview(event) ? 'warn' : status === 'Delivered' ? 'ok' : 'dim'}>{status}</Pill>
      <span className="mt-1 block break-words text-[13px] text-dim">{event.input.text ? event.input.text.slice(0, 160) : `${event.input.media.length} attachment${event.input.media.length === 1 ? '' : 's'}`} · {new Date(event.receivedAt).toLocaleString()}</span>
    </summary>
    <div className="mt-4 flex min-w-0 flex-col gap-4 text-[13px]">
      <div className="break-all text-dim">{({ telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp' })[event.input.platform]} · Sender <code>{event.input.actor.id}</code> · Chat <code>{event.input.conversationId}</code>{event.input.threadId ? <> · Topic <code>{event.input.threadId}</code></> : null} · Message <code>{event.input.sourceMessageId}</code></div>
      <div className="break-all text-dim">Saved project <code>{event.route.projectId}</code> · {event.route.target.kind === 'brain' ? 'The Brain' : <>{event.route.target.kind === 'agent' ? 'Agent' : 'Team'} <code>{event.route.target.id}</code></>}. Destination changes do not redirect saved work.</div>
      {event.input.text && <p tabIndex={0} aria-label="Original message" className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-accent">{event.input.text}</p>}
      {event.reason && <p className="m-0 whitespace-pre-wrap break-words text-dim">{event.reason}</p>}
      {album.length > 0 && <p className="m-0 break-words text-dim">Album source messages: {album.map((item) => item.input.sourceMessageId).join(', ')}. One assignment uses all saved files and captions.</p>}
      {event.album && event.album.leaderId !== event.id && <p className="m-0 break-all text-dim">Grouped with message {leader?.input.sourceMessageId || event.album.leaderId}. Work and delivery receipts are on that message.</p>}
      {candidates.length > 0 && <div>
        <p className="my-2 text-dim">{candidates.length} saved album messages are ready. Check Telegram for all parts before starting one assignment.</p>
        <Button size="small" disabled={busy || !connected} onClick={() => void group()}>Group album and start</Button>
      </div>}
      {event.dismissed && <p className="m-0 text-dim">Dismissed {new Date(event.dismissed.at).toLocaleString()}. Saved text and files stay in Athena. To request this work again, ask the sender to send a new message.</p>}
      {event.status === 'needs-review' && !event.dismissed && <div>
        <p className="m-0 text-dim">This message is held for review. Automatic model replay is disabled. Review the native work and saved destination before starting another assignment.</p>
        {gatewayRequestUnstarted(event) && <div className="mt-2">
          <p className="my-2 text-dim">{paused ? 'Dismiss a request that has never started to let later messages continue. Its saved text and files stay in Athena.' : 'Pause this gateway to dismiss a request that has never started.'}</p>
          <Button size="small" variant="ghost" disabled={busy || !paused} onClick={() => void dismiss(event.id)}>Dismiss request</Button>
        </div>}
        {event.dispatch && event.operationId && !event.reply && event.input.kind === 'message' && (!event.input.mediaGroupId || event.album?.leaderId === event.id) && <div className="mt-2">
          <p className="my-2 text-dim">Check only the original saved operation. If it is complete and still allowed, its saved reply will be delivered. This does not start another run or override edited input.</p>
          <Button size="small" variant="ghost" disabled={busy || !connected} onClick={() => void act(`${base}/reconcile`)}>Check saved work</Button>
        </div>}
      </div>}
      {event.reconciliation && <p role="status" className="m-0 text-dim">{event.reconciliation.state === 'tracking' ? 'Tracking the original saved work.' : event.reconciliation.state === 'completed' ? 'Saved completed answer queued for delivery.' : 'Still held: no completed operation was verified.'} · Checked {new Date(event.reconciliation.at).toLocaleString()}</p>}
      {event.files?.length ? <div><h3 className="m-0 mb-2 text-[13px] font-medium">Incoming files</h3>
        {event.files.map((file) => {
          const size = file.file?.size ?? event.input.media[file.index]?.size;
          return <div key={file.index} className="py-1.5"><span className="break-all">{file.file?.name || event.input.media[file.index]?.name || `Attachment ${file.index + 1}`}</span>{size !== undefined ? ` · ${size.toLocaleString()} bytes` : ''} · {deliveryLabel(file.status)}{file.reason && <div className="mt-1 text-dim">{file.reason}</div>}</div>;
        })}
        {event.status === 'waiting-files' && event.files.some((file) => file.status === 'failed') && <Button size="small" variant="ghost" disabled={busy || !connected} onClick={() => void act(`${base}/retry-files`)}>Retry failed downloads</Button>}
      </div> : null}
      {event.dispatch?.answer && <div><h3 className="m-0 mb-2 text-[13px] font-medium">Final reply</h3><p tabIndex={0} aria-label="Final reply" className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-accent">{event.dispatch.answer}</p></div>}
      {event.status === 'done' && event.dispatch?.state === 'completed' && event.reply && <div>
        <p className="my-2 text-dim">{event.deliveryFinished ? 'Delivery was finished locally. Earlier statuses stay as evidence; this receipt cannot send again.' : 'Pause this gateway to record a delivery confirmed in the messaging app, or finish the remaining delivery locally.'}</p>
        <Button size="small" variant="ghost" disabled={busy} onClick={() => reviewDelivery(event.id)}>Review delivery</Button>
      </div>}
      {event.reply && <div><h3 className="m-0 mb-2 text-[13px] font-medium">Text delivery</h3>
        {event.reply.parts.map((part, index) => <div key={index} className="py-1">Part {index + 1} · {deliveryLabel(part.status)}{part.retryAt && part.status === 'pending' ? ` · Retry after ${new Date(part.retryAt).toLocaleString()}` : ''}</div>)}
        {event.reply.reason && <p className="my-2 text-dim">{event.reply.reason}</p>}
        {!event.deliveryFinished && firstReply && unresolved(firstReply.status) && <Button size="small" variant="ghost" disabled={busy || !connected} onClick={() => void retry('retry-reply', firstReply.status === 'uncertain')}>Retry remaining reply</Button>}
      </div>}
      {event.outgoing?.length ? <div><h3 className="m-0 mb-2 text-[13px] font-medium">Outgoing files</h3>
        {event.outgoing.map((file, index) => <div key={index} className="flex flex-wrap items-start justify-between gap-3 py-2">
          <div className="min-w-0 flex-1"><div className="break-all">{file.name} · {file.size.toLocaleString()} bytes · {deliveryLabel(file.status)}</div>
            {file.reason && <p className="my-1 text-dim">{file.reason}</p>}
            {file.retryAt && file.status === 'pending' ? <div className="text-dim">Retry after {new Date(file.retryAt).toLocaleString()}</div> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {!event.deliveryFinished && unresolved(file.status) && <Button size="small" variant="ghost" disabled={busy || !connected} onClick={() => void retry(`files/${index}/retry`, file.status === 'uncertain')}>Retry file</Button>}
            {!event.deliveryFinished && ['pending', 'failed', 'uncertain'].includes(file.status) && <Button size="small" variant="ghost" disabled={busy || !connected} onClick={() => void skip(index, file.status === 'uncertain')}>Skip file</Button>}
          </div>
        </div>)}
      </div> : null}
      {canSelect && <div>
        <label className="field"><span>Files to send</span><textarea aria-label="Files to send" rows={3} className="font-mono" value={paths} disabled={busy || !connected} onChange={(input) => setPaths(input.target.value)} /></label>
        <p className="my-2 text-dim">Paste absolute file paths, one per line. These files will be sent to this message’s conversation after the final reply. One saved selection per assignment; location, size and contents are checked before sending.</p>
        <Button size="small" disabled={busy || selecting || !connected || !selectedPaths.length || selectedPaths.length > 10} onClick={() => void select()}>{selecting ? 'Selecting…' : 'Send selected files'}</Button>
      </div>}
    </div>
  </details>;
}
