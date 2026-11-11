import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import type { GatewayDiscordRecovery, GatewayInstance } from '../../shared/types.ts';

export function DiscordRecoveryView({
  instance,
  close,
  changed,
}: {
  instance: GatewayInstance;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<GatewayDiscordRecovery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const version = ++request.current;
    setPreview(null);
    setError('');
    try {
      const result = await rpc.gateways.discord.recovery({ id: instance.id });
      if (mounted.current && version === request.current) setPreview(result);
    } catch {
      if (mounted.current && version === request.current)
        setError('The recovery record could not load. Reload it before continuing.');
    }
  }, [instance.id]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load, instance.enabled]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current) {
        await changed();
        await load();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : 'Recovery could not be saved. Reload and review the gap again.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Section
      title={`Discord recovery · ${instance.name}`}
      description="A lost Discord session can leave messages that Athena cannot replay. Review the gap before allowing a fresh connection."
    >
      {error && (
        <div role="alert" className="px-5 py-4 text-red">
          {error}{' '}
          <Button variant="ghost" size="small" disabled={busy} onClick={() => void load()}>
            Reload recovery
          </Button>
        </div>
      )}
      {!preview ? (
        !error && <Row title="Loading recovery record…" />
      ) : preview.gap ? (
        <>
          <Row
            title="Discord could not resume this connection"
            description={`Recorded ${new Date(preview.gap.at).toLocaleString()}. Check Discord for messages Athena may have missed.`}
          />
          <PanelNote>
            Allowing a new session accepts that those missing messages will not be recovered automatically. Saved Athena
            work, replies and file receipts stay in place. Pause the instance first; it will stay paused after this
            review.
          </PanelNote>
          <RowActions>
            {instance.enabled ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    rpc.gateways.change({
                      params: { id: instance.id },
                      body: {
                        name: instance.name,
                        platform: instance.platform,
                        accountId: instance.accountId,
                        projectId: instance.projectId,
                        target: instance.target,
                        senderPolicy: instance.senderPolicy,
                        scope: instance.scope,
                        fileLimits: instance.fileLimits,
                        enabled: false,
                      },
                    }),
                  )
                }
              >
                Pause instance
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    const gap = preview.gap!;
                    if (
                      !(await confirmBox(
                        'Allow a new Discord session? Messages that Discord could not replay will stay missing. Existing Athena work and delivery receipts will be kept. This instance will stay paused until you enable it.',
                        { ok: 'Allow new session' },
                      ))
                    )
                      return;
                    await run(() =>
                      rpc.gateways.discord.reviewRecovery({
                        params: { id: instance.id },
                        body: { revision: gap.revision, acknowledgeGap: true },
                      }),
                    );
                  })()
                }
              >
                Allow new session
              </Button>
            )}
          </RowActions>
        </>
      ) : (
        <Row
          title="No recovery gap is waiting"
          description="Enable the instance from the list when you are ready to connect. Saved work and delivery receipts are unchanged."
        />
      )}
      <RowActions>
        <Button variant="ghost" disabled={busy} onClick={close}>
          Close recovery
        </Button>
      </RowActions>
    </Section>
  );
}
