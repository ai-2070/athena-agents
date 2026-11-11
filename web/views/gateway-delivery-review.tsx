import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row, Section } from '../ui/controls.tsx';
import { SelectControl } from '../ui/select.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayDeliveryReview, GatewayInstance } from '../../shared/types.ts';

const targetKey = (target: GatewayDeliveryReview['items'][number]['target']) => JSON.stringify(target);
const platformNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' };
const labels = {
  pending: 'Waiting',
  sending: 'Interrupted send',
  sent: 'Sent',
  uncertain: 'Delivery uncertain',
  failed: 'Needs review',
  skipped: 'Skipped',
};

export function GatewayDeliveryReviewView({
  instance,
  eventId,
  close,
  changed,
}: {
  instance: GatewayInstance;
  eventId: string;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const at = { id: instance.id, eventId };
  const [preview, setPreview] = useState<GatewayDeliveryReview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [selected, setSelected] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const mounted = useRef(false);
  const request = useRef(0);
  const active = useRef(false);
  const load = useCallback(
    async (clear = true) => {
      const version = ++request.current;
      if (clear) {
        setError('');
        setSaved('');
      }
      try {
        const value = await rpc.gateways.inbox.deliveryReview(at);
        if (mounted.current && request.current === version) setPreview(value);
      } catch (failure) {
        if (mounted.current && request.current === version) {
          setPreview(null);
          setError(
            failure instanceof Error
              ? failure.message
              : 'Delivery receipts could not load. Reload before reviewing them.',
          );
        }
      }
    },
    [instance.id, eventId],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load, instance.enabled]);
  useServerEvents((event) => {
    if (
      (event.type === 'gateways' && event.id === instance.id) ||
      (event.type === 'gateway-inbox' && event.instanceId === instance.id)
    )
      void load(false);
  });
  const options =
    preview?.items
      .filter((item) => item.canConfirm)
      .map((item) => ({ value: targetKey(item.target), label: item.label })) ?? [];
  const picked = options.some((item) => item.value === selected) ? selected : (options[0]?.value ?? '');
  const item = preview?.items.find((item) => targetKey(item.target) === picked);
  const act = async (action: 'prepare' | 'confirm' | 'finish-local') => {
    if (active.current || !mounted.current || !preview) return;
    active.current = true;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const source = `${platformNames[preview.source.platform]} chat ${preview.source.conversationId}, message ${preview.source.messageId}`;
      if (
        action === 'confirm' &&
        (!item?.canConfirm ||
          !(await confirmBox(
            `Record ${item.label} as delivered after checking ${source}? Use the message or file ID shown by the messaging app. This records your confirmation locally; it sends nothing and starts no work.`,
            { ok: 'Record confirmed delivery' },
          )))
      )
        return;
      if (
        action === 'finish-local' &&
        !(await confirmBox(
          `Finish the remaining delivery for ${source} locally? Uncertain parts may already have arrived. This permanently stops this receipt from sending again and cannot be reopened. It does not recall messages. The saved answer and native chats stay in Athena; no model work is replayed.`,
          { ok: 'Finish delivery locally', danger: true },
        ))
      )
        return;
      if (!mounted.current) return;
      const body =
        action === 'confirm'
          ? {
              action,
              revision: preview.revision,
              target: item!.target,
              remoteId: remoteId.trim(),
              acknowledgeChecked: true,
            }
          : { action, revision: preview.revision, acknowledgeNoSend: true };
      const value =
        action === 'prepare'
          ? await rpc.gateways.inbox.prepareDeliveryReview(at)
          : await rpc.gateways.inbox.reviewDelivery({ params: at, body });
      if (mounted.current) {
        setPreview(value);
        setRemoteId('');
        setSaved(
          action === 'prepare'
            ? 'Interrupted sends are now uncertain. Check the messaging app before recording a result.'
            : action === 'confirm'
              ? 'Your delivery confirmation was saved. Other parts keep their own receipts.'
              : 'Delivery finished locally. This receipt will send nothing further.',
        );
        await changed();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : 'The review could not save. Reload its current receipts.',
        );
    } finally {
      if (mounted.current) {
        await load(false);
        setBusy(false);
      }
      active.current = false;
    }
  };
  return (
    <Section
      title={`Delivery review · ${instance.name}`}
      description="Check the messaging app, then record what arrived or stop the remaining delivery while this gateway is paused."
      action={
        <>
          <Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>
            Reload receipts
          </Button>
          <Button size="small" variant="ghost" disabled={busy} onClick={close}>
            Back to inbox
          </Button>
        </>
      }
    >
      {error && (
        <div role="alert" className="px-5 py-4 text-red">
          {error}
        </div>
      )}
      {saved && (
        <div role="status" className="px-5 py-4 text-dim">
          {saved}
        </div>
      )}
      {!preview ? (
        !error && <Row title="Loading delivery receipts…" />
      ) : (
        <>
          <Row
            title={preview.source.actor}
            description={
              <span className="break-words [overflow-wrap:anywhere]">
                {platformNames[preview.source.platform]} · Chat <code>{preview.source.conversationId}</code>
                {preview.source.threadId && (
                  <>
                    {' '}
                    · Thread <code>{preview.source.threadId}</code>
                  </>
                )}{' '}
                · Message <code>{preview.source.messageId}</code>
                <span className="mt-1 block">
                  Saved project <code>{preview.source.projectId}</code> ·{' '}
                  {preview.source.target.kind === 'brain' ? (
                    'The Brain'
                  ) : (
                    <>
                      {preview.source.target.kind} <code>{preview.source.target.id}</code>
                    </>
                  )}
                  . This is the original destination.
                </span>
              </span>
            }
          />
          {preview.reason && (
            <Row
              title={preview.closedAt ? 'Delivery finished locally' : 'Before reviewing delivery'}
              description={
                <>
                  {preview.reason}
                  {preview.closedAt && (
                    <span className="mt-1 block">
                      Recorded {new Date(preview.closedAt).toLocaleString()}. Earlier delivery statuses are kept below.
                    </span>
                  )}
                </>
              }
            />
          )}
          {preview.needsPrepare && (
            <Row
              title="Interrupted receipts"
              description="Classify the saved in-flight sends as uncertain. This only updates local receipts; it does not contact the messaging app."
            >
              <Button size="small" disabled={busy || instance.enabled} onClick={() => void act('prepare')}>
                Recover interrupted receipts
              </Button>
            </Row>
          )}
          {!preview.items.length && (
            <Row title="No delivery receipts" description="Check the saved native work in the inbox." />
          )}
          {preview.items.map((item) => (
            <Row
              key={targetKey(item.target)}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all">{item.label}</span>
                  <Pill
                    tone={
                      item.status === 'sent'
                        ? 'ok'
                        : item.status === 'uncertain' || item.status === 'failed'
                          ? 'warn'
                          : 'dim'
                    }
                  >
                    {labels[item.status]}
                  </Pill>
                </span>
              }
              description={
                <>
                  {item.remoteId && (
                    <span className="block break-all">
                      Messaging app ID <code>{item.remoteId}</code>
                    </span>
                  )}
                  {item.confirmedAt && (
                    <span className="block">Confirmed locally {new Date(item.confirmedAt).toLocaleString()}.</span>
                  )}
                  {item.text && (
                    <details className="mt-2">
                      <summary className="cursor-pointer rounded-ctl focus-visible:outline-2 focus-visible:outline-accent">
                        Show saved text
                      </summary>
                      <p
                        tabIndex={0}
                        aria-label={item.label}
                        className="mb-0 max-h-48 overflow-auto whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {item.text}
                      </p>
                    </details>
                  )}
                </>
              }
            />
          ))}
          {options.length > 0 && (
            <Row
              title="Record a confirmed delivery"
              description="Only choose a part you found in the messaging app. Pending and unattempted parts cannot be confirmed."
              stack
            >
              <div className="flex w-full max-w-xl flex-col gap-3">
                <SelectControl
                  aria-label="Delivery to confirm"
                  value={picked}
                  options={options}
                  onChange={setSelected}
                />
                <label className="field">
                  <span>Messaging app ID</span>
                  <input
                    aria-label="Messaging app ID"
                    value={remoteId}
                    maxLength={500}
                    disabled={busy}
                    onChange={(event) => setRemoteId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div>
                  <Button
                    size="small"
                    disabled={
                      busy || instance.enabled || !item?.canConfirm || !remoteId.trim() || /\s/.test(remoteId.trim())
                    }
                    onClick={() => void act('confirm')}
                  >
                    Record confirmed delivery
                  </Button>
                </div>
              </div>
            </Row>
          )}
          {preview.canFinish && (
            <Row
              title="Finish without more sends"
              description="Keep the saved answer and every receipt, including uncertainty. This permanently closes delivery for this answer. Later messages can continue once other holds are resolved and the gateway is enabled."
            >
              <Button
                size="small"
                variant="danger"
                disabled={busy || instance.enabled}
                onClick={() => void act('finish-local')}
              >
                Finish delivery locally
              </Button>
            </Row>
          )}
        </>
      )}
      <PanelNote>
        These local actions never send messages, select new files or replay model work. Confirmed parts and byte
        reservations stay recorded. Native agents and approvals keep their controls in Athena.
      </PanelNote>
    </Section>
  );
}
