import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInstance, GatewayWhatsAppSenders } from '../../shared/types.ts';

export function WhatsAppSendersView({
  instance,
  close,
  edit,
  changed,
}: {
  instance: GatewayInstance;
  close: () => void;
  edit: () => void;
  changed: () => Promise<void>;
}) {
  const id = instance.id;
  const [preview, setPreview] = useState<GatewayWhatsAppSenders | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const active = useRef(false);
  const load = useCallback(
    async (clearError = true) => {
      const version = ++request.current;
      if (clearError) {
        setError('');
        setSaved(false);
      }
      try {
        const value = await rpc.gateways.whatsapp.senders({ id });
        if (mounted.current && version === request.current) setPreview(value);
      } catch (failure) {
        if (mounted.current && version === request.current) {
          setPreview(null);
          setError(
            failure instanceof Error ? failure.message : 'Sender records could not load. Reload before reviewing them.',
          );
        }
      }
    },
    [id],
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
  const review = async (sender: GatewayWhatsAppSenders['senders'][number]) => {
    if (active.current || !mounted.current || !sender.revision) return;
    active.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      if (
        !(await confirmBox(
          `Start a fresh conversation for ${sender.phone} after this verified identity change? Earlier requests, files and delivery receipts stay held. Native agents keep their controls in Athena. Ask this person to message again after the review. This instance stays paused.`,
          { ok: 'Review sender' },
        )) ||
        !mounted.current
      )
        return;
      await rpc.gateways.whatsapp.reviewSender({
        params: { id },
        body: { phone: sender.phone, revision: sender.revision, acknowledgeNewConversation: true },
      });
      if (mounted.current) {
        setSaved(true);
        await changed();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'The sender review could not save. Reload its current signed proof.',
        );
    } finally {
      if (mounted.current) await load(false);
      if (mounted.current) setBusy(false);
      active.current = false;
    }
  };
  const labels = {
    'needs-proof': 'Needs phone proof',
    verified: 'Verified',
    'needs-review': 'Needs review',
    reviewed: 'Reviewed',
  };
  return (
    <Section
      title={`WhatsApp senders · ${instance.name}`}
      description="Review signed phone associations after a sender changes identity. A fresh conversation keeps earlier work separate."
      action={
        <>
          <Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>
            Reload senders
          </Button>
          <Button size="small" variant="ghost" disabled={busy} onClick={close}>
            Back to relay setup
          </Button>
        </>
      }
    >
      {error && (
        <div role="alert" className="px-5 py-4 text-red">
          {error}
        </div>
      )}
      {!preview ? (
        !error && <Row title="Loading sender records…" />
      ) : (
        <>
          {saved && (
            <Row
              title="Sender review saved"
              description={
                <span role="status">
                  Ask this person to message again. New signed messages will use a fresh private conversation; earlier
                  requests still need their own review.
                </span>
              }
            />
          )}
          {preview.reason && <Row title="Before reviewing a sender" description={preview.reason} />}
          <Row
            title="Signed sender records"
            description={`${preview.retired} retired ${preview.retired === 1 ? 'sender ID stays' : 'sender IDs stay'} blocked. ${preview.waiting} ${preview.waiting === 1 ? 'sender ID needs' : 'sender IDs need'} phone proof. ${preview.unallowed} verified ${preview.unallowed === 1 ? 'phone number is' : 'phone numbers are'} outside the allowed list.`}
          />
          {!preview.senders.length && (
            <Row
              title="No allowed phone numbers"
              description="Add full international phone numbers in the instance editor, then wait for signed phone proof."
            />
          )}
          {preview.senders.map((sender) => (
            <Row
              key={sender.phone}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{sender.phone}</span>
                  <Pill tone={sender.status === 'verified' || sender.status === 'reviewed' ? 'ok' : 'warn'}>
                    {labels[sender.status]}
                  </Pill>
                </span>
              }
              description={
                <>
                  {sender.reason}
                  <span className="mt-1 block">
                    {sender.requests} saved {sender.requests === 1 ? 'request' : 'requests'} kept.
                    {sender.changedAt !== undefined &&
                      ` Identity change recorded ${new Date(sender.changedAt).toLocaleString()}.`}
                  </span>
                </>
              }
            >
              {sender.revision && (
                <Button size="small" disabled={busy || instance.enabled} onClick={() => void review(sender)}>
                  Review sender
                </Button>
              )}
            </Row>
          ))}
          <RowActions>
            <Button variant="ghost" size="small" disabled={busy} onClick={edit}>
              Edit allowed phones
            </Button>
            <ButtonLink
              variant="ghost"
              size="small"
              href={`#/settings?tab=gateways&inbox=${encodeURIComponent(instance.id)}`}
            >
              Open inbox
            </ButtonLink>
          </RowActions>
        </>
      )}
      <PanelNote>
        Phone permissions still come from the allowed list and signed platform proof. A review never restores a retired
        ID or adds a phone number. It starts no work and sends no messages. WhatsApp receiving and sending remain
        disabled.
      </PanelNote>
    </Section>
  );
}
