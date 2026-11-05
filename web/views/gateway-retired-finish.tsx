import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, confirmBox } from '../core.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayRetiredFinishReview } from '../../shared/types.ts';

const labels = { pending: 'Waiting when saved', sending: 'Interrupted send', sent: 'Confirmed', uncertain: 'Delivery uncertain', failed: 'Failed', skipped: 'Skipped' };
const platforms = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' };

// Extend the removed-instance history in its existing Settings plate: source first, saved outcomes,
// then one confirmed local finish. Recovery is explicit; the old connection remains blocked.
export function GatewayRetiredFinishView({ instanceId, eventId, close, changed }: {
  instanceId: string; eventId: string; close: () => void; changed: () => Promise<void>;
}) {
  const root = `/gateways/retired/${encodeURIComponent(instanceId)}/inbox/${encodeURIComponent(eventId)}/local-finish`;
  const [preview, setPreview] = useState<GatewayRetiredFinishReview | null>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const load = useCallback(async (clear = true) => {
    const version = ++request.current;
    if (clear) { setError(''); setNotice(''); setPreview(null); }
    try { const value = await GET<GatewayRetiredFinishReview>(root); if (mounted.current && request.current === version) setPreview(value); }
    catch (failure) { if (mounted.current && request.current === version) { setPreview(null); setError(failure instanceof Error ? failure.message : 'Saved receipts could not load. Reload the local-finish review.'); } }
  }, [root]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  useServerEvents((event) => { if ((event.type === 'gateways' && event.id === instanceId) || (event.type === 'gateway-inbox' && event.instanceId === instanceId)) void load(false); });
  const act = async (prepare: boolean) => {
    if (active.current || !mounted.current || !preview || (prepare ? !preview.needsPrepare : !preview.canFinish)) return;
    const snapshot = preview; active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const source = `${platforms[snapshot.source.platform]} chat ${snapshot.source.conversationId}, message ${snapshot.source.messageId}, saved project ${snapshot.source.projectId}`;
      if (!prepare && !await confirmBox(`Finish ${snapshot.kind === 'work' ? 'gateway tracking for the saved native work' : 'remaining delivery'} for ${source} locally? ${snapshot.kind === 'work' ? 'Native work may still be running. Manage it through Athena’s usual controls. This receipt will never track it again or send its reply or files. ' : 'Uncertain parts may already have arrived. This receipt will never send again. '}The saved input, native work IDs, files, confirmed receipts and uncertainty stay. The removed connection remains blocked. This cannot be undone.`, { ok: 'Finish locally', danger: true })) return;
      if (!mounted.current) return;
      const value = await POST<GatewayRetiredFinishReview>(prepare ? `${root}/prepare` : root, prepare ? { revision: snapshot.revision } : { revision: snapshot.revision, acknowledgeNoSend: true, acknowledgeMayStillRun: true });
      if (mounted.current) { setPreview(value); setError(''); setNotice(prepare ? 'Interrupted receipts recovered locally. In-flight sends are now uncertain. No work was started and nothing was sent.' : 'Finished locally. Saved evidence is kept and the removed connection stays blocked.'); await changed(); }
    } catch (failure) { if (mounted.current) { setPreview(null); setError(failure instanceof Error ? failure.message : 'Local finish could not be saved. Reload its receipts before continuing.'); } }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const native = preview?.native?.conversation;
  return <>
    <Row title="Review local finish" description="Keep this receipt in Athena and permanently close its remaining gateway delivery or tracking. The removed connection stays blocked.">
      <Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload local-finish review</Button>
      <Button size="small" variant="ghost" onClick={close}>Back to saved history</Button>
    </Row>
    {error && <div role="alert" className="px-5 py-4 text-red [overflow-wrap:anywhere]">{error}</div>}
    {notice && <div role="status" className="px-5 py-4 text-dim">{notice}</div>}
    {!preview ? !error && <Row title={<span role="status">Loading local-finish review…</span>} /> : <>
      <Row title={preview.source.actor || 'Saved source'} description={<span className="[overflow-wrap:anywhere]">{platforms[preview.source.platform]} · Chat <code>{preview.source.conversationId}</code>{preview.source.threadId && <> · Thread <code>{preview.source.threadId}</code></>} · Message <code>{preview.source.messageId}</code><span className="mt-1 block">Original project <code>{preview.source.projectId}</code> · {preview.source.target.kind === 'brain' ? 'The Brain' : <>{preview.source.target.kind === 'agent' ? 'Agent' : 'Team'} <code>{preview.source.target.id}</code></>}.</span></span>} />
      {preview.reason && <Row title={preview.closedAt !== undefined ? 'Finished locally' : 'Before finishing locally'} description={<>{preview.reason}{preview.closedAt !== undefined && <span className="mt-1 block">Recorded {new Date(preview.closedAt).toLocaleString()}. Earlier statuses remain as evidence.</span>}</>} />}
      {preview.operationId && <Row title="Saved native work" description={<span className="[overflow-wrap:anywhere]">These are saved IDs, not a live native-status check. Operation <code>{preview.operationId}</code>{preview.native?.runId && <span className="block">Run <code>{preview.native.runId}</code></span>}{preview.native?.messageId && <span className="block">Native message <code>{preview.native.messageId}</code></span>}{preview.native?.briefId && <span className="block">Review <code>{preview.native.briefId}</code></span>}{native && <span className="block">Private conversation <code>{native.conversationId}</code>{native.kind === 'agent' && <> · Agent <code>{native.agentId}</code> · Chat <code>{native.chatId}</code></>}{native.kind === 'team' && <> · Team <code>{native.teamId}</code></>}</span>}</span>} />}
      {preview.needsPrepare && <Row title="Interrupted receipts" description="Recover only this request's in-flight receipts before finishing. Sends become uncertain locally; this contacts no messaging service."><Button size="small" disabled={busy} onClick={() => void act(true)}>Recover interrupted receipts</Button></Row>}
      {preview.items.map((item, index) => <Row key={index} title={<span className="flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">{item.label}<Pill tone={item.status === 'sent' ? 'ok' : item.status === 'uncertain' || item.status === 'failed' ? 'warn' : 'dim'}>{labels[item.status]}</Pill></span>}
        description={<>{item.remoteId && <span className="block [overflow-wrap:anywhere]">Messaging-app ID <code>{item.remoteId}</code></span>}{item.text && <details className="mt-2"><summary className="cursor-pointer rounded-ctl focus-visible:outline-2 focus-visible:outline-accent">Show saved text</summary><p tabIndex={0} className="mb-0 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent">{item.text}</p></details>}</>} />)}
      {preview.kind === 'work' && <Row title="Native work stays in Athena" description={`Local finish stops gateway tracking and any future reply or files for this request. It does not stop, complete or replay the native work. ${preview.heldRequests} other saved request${preview.heldRequests === 1 ? '' : 's'} in this conversation ${preview.heldRequests === 1 ? 'stays' : 'stay'} held.`} />}
      {preview.canFinish && <Row title={preview.kind === 'work' ? 'Keep work in Athena' : 'Finish remaining delivery'} description="Keep saved input, files, confirmed IDs, uncertainty and byte reservations. This closes the receipt permanently."><Button size="small" variant="danger" disabled={busy} onClick={() => void act(false)}>Finish locally</Button></Row>}
    </>}
    <PanelNote>These actions update local receipts only. They never send, reconnect the removed instance or start native work. New instances keep their own history.</PanelNote>
  </>;
}
