import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInstance, GatewayWorkReview } from '../../shared/types.ts';

const platforms = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' };
const requestCount = (count: number): string => `${count} other saved ${count === 1 ? 'request' : 'requests'}`;
export function GatewayWorkReviewView({ instance, eventId, close, changed }: {
  instance: GatewayInstance; eventId: string; close: () => void; changed: () => Promise<void>;
}) {
  const at = { id: instance.id, eventId };
  const [preview, setPreview] = useState<GatewayWorkReview | null>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const active = useRef(false);
  const load = useCallback(async (clear = true) => {
    const version = ++request.current; if (clear) { setError(''); setNotice(''); }
    try { const value = await rpc.gateways.inbox.workReview(at); if (mounted.current && version === request.current) setPreview(value); }
    catch (failure) { if (mounted.current && version === request.current) { setPreview(null); setError(failure instanceof Error ? failure.message : 'Saved work could not load. Reload before reviewing it.'); } }
  }, [instance.id, eventId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load, instance.enabled]);
  useServerEvents((event) => { if ((event.type === 'gateways' && event.id === instance.id) || (event.type === 'gateway-inbox' && event.instanceId === instance.id)) void load(false); });
  const act = async (action: 'prepare' | 'keep') => {
    if (active.current || !mounted.current || !preview) return;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'keep' && !await confirmBox(`Keep the work for ${platforms[preview.source.platform]} chat ${preview.source.conversationId}, message ${preview.source.messageId}, in Athena? Native work may still be running. This does not stop it, finish it or start it again. This request will never send a reply or files through this gateway. ${requestCount(preview.heldRequests)} ${preview.heldRequests === 1 ? 'stays' : 'stay'} held; new incoming messages will use a separate private conversation after enabling. This cannot be undone. Manage existing native work in Athena before continuing.`, { ok: 'Keep work in Athena', danger: true })) return;
      if (!mounted.current) return;
      const value = action === 'keep' ? await rpc.gateways.inbox.keepWork({ params: at, body: { revision: preview.revision, acknowledgeMayStillRun: true, acknowledgeFreshConversation: true, acknowledgeNoReply: true } }) : await rpc.gateways.inbox.prepareWorkReview(at);
      if (mounted.current) { setPreview(value); setNotice(action === 'keep' ? 'Work kept in Athena. Ask the sender for a new message when ready. This instance is still paused.' : 'Interrupted receipts are now classified locally. Check the messaging app for uncertain notices or files.'); await changed(); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The work review could not save. Reload the current receipts.'); }
    finally { if (mounted.current) { await load(false); setBusy(false); } active.current = false; }
  };
  const local = preview?.native?.conversation;
  return <Section title={`Saved work review · ${instance.name}`} description="Keep an unfinished request in Athena without another gateway reply. Native work keeps its own controls and may still be running."
    action={<><Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>Reload receipts</Button><Button size="small" variant="ghost" disabled={busy} onClick={close}>Back to inbox</Button></>}>
    {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
    {notice && <div role="status" className="px-5 py-4 text-dim">{notice}</div>}
    {!preview ? !error && <Row title="Loading saved work…" /> : <>
      <Row title={preview.source.actor} description={<span className="break-words [overflow-wrap:anywhere]">{platforms[preview.source.platform]} · Chat <code>{preview.source.conversationId}</code>{preview.source.threadId && <> · Thread <code>{preview.source.threadId}</code></>} · Message <code>{preview.source.messageId}</code><span className="mt-1 block">Saved project <code>{preview.source.projectId}</code> · {preview.source.target.kind === 'brain' ? 'The Brain' : <>{preview.source.target.kind} <code>{preview.source.target.id}</code></>}. This is the original destination.</span></span>} />
      {preview.reason && <Row title={preview.keptAt ? 'Kept in Athena' : 'Before reviewing work'} description={<>{preview.reason}{preview.keptAt && <span className="mt-1 block">Recorded {new Date(preview.keptAt).toLocaleString()}. Saved receipts and native operation IDs are retained.</span>}</>} />}
      <Row title={<span className="flex flex-wrap items-center gap-2"><span>Saved native work</span><Pill>{preview.native ? ({ starting: 'Starting receipt', running: 'Working receipt', completed: 'Completion receipt', 'needs-review': 'Held receipt' })[preview.native.state] : 'Reservation only'}</Pill></span>}
        description={<><span>These are saved gateway receipts, not a live native status check. Review or stop the original work using Athena's native controls.</span>{preview.operationId && <details className="mt-2"><summary className="cursor-pointer rounded-ctl focus-visible:outline-2 focus-visible:outline-accent">Show saved work IDs</summary><div className="mt-2 break-words [overflow-wrap:anywhere]">Operation <code>{preview.operationId}</code>{preview.native?.runId && <div>Run <code>{preview.native.runId}</code></div>}{preview.native?.messageId && <div>Native message <code>{preview.native.messageId}</code></div>}{preview.native?.briefId && <div>Review <code>{preview.native.briefId}</code></div>}{local && <div>Private conversation <code>{local.conversationId}</code>{local.kind === 'agent' && <> · Agent <code>{local.agentId}</code> · Chat <code>{local.chatId}</code></>}{local.kind === 'team' && <> · Team <code>{local.teamId}</code></>}</div>}</div></details>}</>} />
      {preview.needsPrepare && <Row title="Interrupted receipts" description="Recover this request's saved in-flight notices or files as uncertain. No provider request is made; native work is not stopped or restarted."><Button size="small" disabled={busy || instance.enabled} onClick={() => void act('prepare')}>Recover interrupted receipts</Button></Row>}
      {!preview.keptAt && <Row title="Earlier requests stay held" description={`${requestCount(preview.heldRequests)} in this conversation will stay held. This review never starts them again. New incoming messages stay separate from this work and follow the instance's current project, destination and sender rules.`} />}
      {preview.canKeep && <Row title="Keep work in Athena" description="Permanently stop gateway tracking and any future reply or files for this request. The native operation, saved input, files and byte reservations stay intact. This does not prove native work finished; use its normal stop or review controls first.">
        <Button size="small" variant="danger" disabled={busy || instance.enabled} onClick={() => void act('keep')}>Keep work in Athena</Button>
      </Row>}
    </>}
    <PanelNote>This local review never approves tools, sends messages or replays model work. The gateway stays paused. Its saved work receipts are retained for recovery; this action does not make them eligible for inbox cleanup.</PanelNote>
  </Section>;
}
