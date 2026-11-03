import { useEffect, useRef, useState } from 'react';
import { GET, POST, PUT, ago, confirmBox, toast } from '../core.ts';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { Plate } from '../ui/surface.tsx';
import { Section } from '../ui/controls.tsx';
import { SelectControl } from '../ui/select.tsx';
import { openModal } from '../ui/overlays.tsx';
import type { OpenDialog } from '../ui/overlays.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayOutboxDestination, GatewayOutboxPostPreview, GatewayOutboxPreview, GatewayOutboxProgress, OutboxPost } from '../../shared/types.ts';

const platformName = (platform: string) => platform === 'discord' ? 'Discord' : 'Telegram';
const problem = (failure: unknown) => failure instanceof Error ? failure.message : 'The gateway draft could not save. Reload it before continuing.';
const labels: Record<GatewayOutboxProgress['state'], string> = { queued: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Failed', uncertain: 'Delivery uncertain', held: 'Held', closed: 'Finished locally', unavailable: 'Receipts unavailable' };

export function GatewayCompose({ added }: { added: () => void }) {
  const [open, setOpen] = useState(false); const [platform, setPlatform] = useState('telegram'); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const active = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    if (active.current) return; active.current = true; setBusy(true); setError('');
    try { await POST('/outbox', { platform, text }); if (mounted.current) { setText(''); setOpen(false); added(); } }
    catch (failure) { if (mounted.current) setError(problem(failure)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  return <Section title="Gateway message" description="Draft a Telegram or Discord follow-up, then choose a known conversation and review before sending." bare>
    {!open ? <Button size="small" variant="ghost" onClick={() => setOpen(true)}>Draft a message</Button> : <div className="flex flex-col gap-3 max-w-2xl">
      <SelectControl aria-label="Message platform" value={platform} onChange={setPlatform} options={[{ value: 'telegram', label: 'Telegram' }, { value: 'discord', label: 'Discord' }]} />
      <textarea aria-label="New gateway message" rows={4} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
      {error && <p role="alert" className="text-red">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button size="small" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save draft'}</Button><Button size="small" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
    </div>}
  </Section>;
}

function Recipient({ value }: { value: GatewayOutboxPreview['recipient'] }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm min-w-0 [overflow-wrap:anywhere]">
    <dt className="text-dim">Instance</dt><dd className="min-w-0">{value.instanceName} · {platformName(value.platform)}</dd>
    <dt className="text-dim">Bot account</dt><dd className="min-w-0"><code>{value.accountId}</code></dd>
    <dt className="text-dim">Conversation</dt><dd className="min-w-0"><code>{value.conversationId}</code>{value.threadId && <> · thread <code>{value.threadId}</code></>}</dd>
    <dt className="text-dim">Reply to</dt><dd className="min-w-0">{value.sender} · message <code>{value.sourceMessageId}</code></dd>
  </dl>;
}

function SendReview({ id, preview, close, changed, alive }: { id: string; preview: GatewayOutboxPostPreview; close: () => void; changed: () => void; alive: () => boolean }) {
  const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [stale, setStale] = useState(false);
  const active = useRef(false); const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useServerEvents((event) => { if (event.type === 'project' || (event.type === 'outbox' && event.id === id) || (event.type === 'gateways' && event.id === preview.approval.instanceId)) setStale(true); });
  const approve = async () => {
    if (active.current || !mounted.current || !alive() || !checked || stale) return; active.current = true; setBusy(true); setError('');
    try {
      await POST(`/outbox/${encodeURIComponent(id)}/approve`, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision });
      if (mounted.current) { toast('Approved. Follow delivery progress in Outbox.'); changed(); close(); }
    } catch (failure) { if (mounted.current) { setError(problem(failure)); setStale(true); changed(); } }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  return <><div className="modal-body flex flex-col gap-5">
    <p className="text-dim">Check the selected account, conversation and every text part. Approval queues this exact message for delivery.</p>
    <Recipient value={preview.recipient} />
    <ol className="flex flex-col gap-4 list-none p-0 m-0">
      {preview.approval.parts.map((text, index) => <li key={index} className="border-t border-line pt-4 min-w-0"><p className="text-sm text-dim mb-2">Part {index + 1} of {preview.approval.parts.length}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p></li>)}
    </ol>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={busy || stale} onChange={(event) => setChecked(event.target.checked)} /><span>I checked the recipient and full text.</span></label>
    {stale && <p role="status" className="text-dim">Close this review and review the current draft again before sending.</p>}
    {error && <p role="alert" className="text-red">{error}</p>}
  </div><div className="modal-foot flex flex-wrap gap-2"><Button disabled={busy || stale || !checked} onClick={() => void approve()}>{busy ? 'Approving…' : 'Approve & send'}</Button><Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button></div></>;
}

export function GatewayOutboxCard({ p, changed }: { p: OutboxPost; changed: () => void }) {
  const progress = p.gatewayProgress; const locked = Boolean(progress || p.gatewayApprovedRevision || p.status === 'posting');
  const editable = !locked && ['pending', 'failed'].includes(p.status);
  const [parts, setParts] = useState(p.parts); const [gateway, setGateway] = useState(p.gateway); const [baseline, setBaseline] = useState(p.gatewayDraftRevision);
  const [choices, setChoices] = useState<GatewayOutboxDestination[] | null>(null); const [choicesError, setChoicesError] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const edited = useRef(false); const active = useRef(false); const mounted = useRef(true); const dialog = useRef<OpenDialog | null>(null); const loadId = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadId.current++; dialog.current?.close(); }; }, []);
  useEffect(() => { if (!edited.current) { setParts(p.parts); setGateway(p.gateway); setBaseline(p.gatewayDraftRevision); } }, [p.gatewayDraftRevision, p.parts, p.gateway]);
  const loadChoices = async () => {
    const version = ++loadId.current; setChoicesError('');
    try { const value = await GET<GatewayOutboxDestination[]>('/outbox/gateway-destinations'); if (mounted.current && version === loadId.current) setChoices(value.filter((item) => item.recipient.platform === p.platform)); }
    catch (failure) { if (mounted.current && version === loadId.current) { setChoices(null); setChoicesError(problem(failure)); } }
  };
  useEffect(() => { if (editable) void loadChoices(); }, [editable, p.platform]);
  useServerEvents((event) => { if (editable && (event.type === 'gateway-health' || event.type === 'gateways')) void loadChoices(); });
  const act = async (action: 'review' | 'save' | 'reject' | 'finish' | 'return') => {
    if (active.current) return; active.current = true; setBusy(true); setError('');
    try {
      const root = `/outbox/${encodeURIComponent(p.id)}`;
      if (action === 'finish') {
        if (!progress?.reviewRevision || !await confirmBox(`Finish delivery locally for ${progress.recipient?.instanceName || p.accountLabel || platformName(p.platform)}, conversation ${progress.recipient?.conversationId || ''}? Confirmed parts stay confirmed. The remaining parts will never send from this post. Uncertain parts may already have arrived; check the messaging app before creating a new draft. This cannot be undone.`, { ok: 'Finish locally', danger: true })) return;
        if (!mounted.current) return;
        await POST(`${root}/gateway-finish`, { revision: progress.reviewRevision, acknowledgeNoSend: true });
      } else if (action === 'reject') await POST(`${root}/reject`, {});
      else if (action === 'return') await POST(`${root}/discuss`, { text: feedback });
      else {
        const body = { gateway, parts, draftRevision: baseline };
        if (action === 'save') await PUT(root, body);
        else {
          const preview = await POST<GatewayOutboxPostPreview>(`${root}/gateway-review`, body);
          if (!mounted.current) return;
          setParts(preview.approval.parts); setGateway({ instanceId: preview.approval.instanceId, eventId: preview.approval.eventId }); setBaseline(preview.draftRevision);
          dialog.current = openModal('Review gateway message', (close) => <SendReview id={p.id} preview={preview} close={close} changed={changed} alive={() => mounted.current} />);
        }
        edited.current = false;
      }
      if (mounted.current) changed();
    } catch (failure) { if (mounted.current) { setError(problem(failure)); changed(); } }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const instanceChoices = [...new Map((choices ?? []).map((item) => [item.instanceId, item.recipient.instanceName])).entries()];
  const selected = choices?.find((item) => item.instanceId === gateway?.instanceId && item.eventId === gateway?.eventId);
  const missingInstance = gateway?.instanceId && !instanceChoices.some(([id]) => id === gateway.instanceId) ? [{ value: gateway.instanceId, label: `${p.accountLabel || 'Saved instance'} (unavailable)` }] : [];
  const missingConversation = gateway?.eventId && !selected ? [{ value: gateway.eventId, label: 'Saved conversation (unavailable)' }] : [];
  const label = progress ? labels[progress.state] : p.status === 'rejected' ? 'Rejected' : p.status === 'returned' ? 'Sent back' : 'Waiting';
  return <Plate className="panel gateway-outbox min-w-0">
    <div className="flex flex-wrap items-center gap-3"><Pill tone={progress?.state === 'sent' ? 'ok' : progress?.state === 'uncertain' || progress?.state === 'failed' || progress?.state === 'unavailable' ? 'bad' : 'dim'}>{label}</Pill><b>{platformName(p.platform)} · {p.accountLabel || 'Choose a recipient'}</b><span className="text-sm text-dim">by {p.agentName || 'you'} · {ago(p.createdAt)}</span></div>
    {p.note && <p className="text-dim mt-4">{p.note}</p>}
    {editable && <fieldset disabled={busy} className="flex flex-col gap-4 mt-5 min-w-0">
      <div className="grid grid-cols-2 max-md:grid-cols-1 gap-3">
        <label className="flex flex-col gap-2 text-sm">Instance<SelectControl aria-label="Gateway instance" value={gateway?.instanceId ?? ''} onChange={(value) => { edited.current = true; setGateway(value ? { instanceId: value, eventId: '' } : undefined); }} options={[{ value: '', label: 'Choose an instance' }, ...missingInstance, ...instanceChoices.map(([value, label]) => ({ value, label }))]} /></label>
        <label className="flex flex-col gap-2 text-sm">Conversation<SelectControl aria-label="Gateway conversation" value={gateway?.eventId ?? ''} onChange={(eventId) => { edited.current = true; if (gateway) setGateway({ ...gateway, eventId }); }} options={[{ value: '', label: 'Choose a conversation' }, ...missingConversation, ...(choices ?? []).filter((item) => item.instanceId === gateway?.instanceId).map((item) => ({ value: item.eventId, label: `${item.recipient.sender} · ${item.recipient.conversationId}${item.recipient.threadId ? ` / ${item.recipient.threadId}` : ''}` }))]} /></label>
      </div>
      {!choices && !choicesError && <p role="status" className="text-sm text-dim">Loading known conversations…</p>}
      {choicesError && <p role="alert" className="text-red">{choicesError}</p>}
      {choices?.length === 0 && <p className="text-sm text-dim">No completed conversations are available. Set up and enable an instance in Gateways, receive a message, and confirm its reply before choosing it here.</p>}
      {gateway?.eventId && !selected && choices && <p role="status" className="text-sm text-dim">The saved recipient is no longer available. Refresh the list and check this instance’s setup.</p>}
      <div className="flex flex-wrap gap-3"><Button variant="ghost" size="tiny" onClick={() => void loadChoices()}>Refresh recipients</Button><ButtonLink variant="ghost" size="tiny" href="#/settings?tab=gateways">Open Gateways</ButtonLink></div>
      {parts.map((text, index) => <label key={index} className="flex flex-col gap-2 text-sm">{parts.length > 1 ? `Part ${index + 1}` : 'Message'}<textarea aria-label={parts.length > 1 ? `Gateway part ${index + 1}` : 'Gateway message'} rows={Math.min(8, Math.ceil(text.length / 75) + 2)} value={text} onChange={(event) => { edited.current = true; setParts(parts.map((part, i) => i === index ? event.target.value : part)); }} /></label>)}
      <p className="text-sm text-dim">Review saves your edits and shows the full recipient and text. Sending waits for approval.</p>
      <div className="flex flex-wrap gap-2"><Button size="small" disabled={!selected || !parts.some((part) => part.trim())} onClick={() => void act('review')}>{busy ? 'Saving…' : 'Review & send'}</Button><Button size="small" variant="ghost" disabled={!selected} onClick={() => void act('save')}>Save edits</Button><Button size="small" variant="ghost" onClick={() => { edited.current = false; setParts(p.parts); setGateway(p.gateway); setBaseline(p.gatewayDraftRevision); setError(''); changed(); }}>Reload draft</Button>{p.teamId && <Button size="small" variant="ghost" onClick={() => setFeedback(feedback === null ? '' : null)}>Send back to team</Button>}<Button size="small" variant="danger" onClick={() => void act('reject')}>Reject</Button></div>
      {feedback !== null && <><textarea aria-label="Changes for the team" rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} /><Button size="small" disabled={!feedback.trim()} onClick={() => void act('return')}>Send feedback to team</Button></>}
    </fieldset>}
    {!editable && <div className="flex flex-col gap-4 mt-5">
      {progress?.recipient && <Recipient value={progress.recipient} />}
      {p.parts.map((text, index) => <div key={index} className="border-t border-line pt-4 min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm text-dim mb-2"><span>Part {index + 1} of {p.parts.length}</span>{progress?.parts[index] && <><span>·</span><span>{progress.parts[index].status === 'sent' ? 'Confirmed' : progress.parts[index].status === 'pending' ? 'Waiting' : progress.parts[index].status === 'sending' ? 'Sending' : progress.parts[index].status === 'uncertain' ? 'Delivery uncertain' : 'Failed'}</span></>}</div><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>{progress?.parts[index]?.remoteId && <details className="text-sm text-dim mt-2"><summary>Delivery receipt</summary><code className="break-all">{progress.parts[index].remoteId}</code></details>}</div>)}
      {progress?.reviewRevision && <div className="flex flex-col gap-3"><p className="text-sm text-dim">To stop the remaining delivery, pause this instance in Gateways, then finish this post locally. This keeps confirmed receipts and any uncertainty.</p><div className="flex flex-wrap gap-2"><ButtonLink variant="ghost" size="small" href={`#/settings?tab=gateways&instance=${encodeURIComponent(p.gateway?.instanceId ?? '')}`}>Open this gateway</ButtonLink><Button size="small" variant="danger" disabled={busy || !progress.paused} onClick={() => void act('finish')}>Finish locally</Button></div></div>}
      {progress?.state === 'closed' && <p className="text-sm text-dim">Finished locally. Unsent parts will not send from this post. An uncertain part may already have arrived.</p>}
    </div>}
    {(error || p.error) && <p role="alert" className="text-red mt-4 [overflow-wrap:anywhere]">{error || p.error}</p>}
  </Plate>;
}
