import { useCallback, useEffect, useRef, useState } from 'react';
import { GET, POST, PUT, DEL, confirmBox, toast } from '../core.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { SelectControl } from '../ui/select.tsx';
import { useServerEvents } from '../ui/react.tsx';
import { gatewayPlatformAvailable } from '../../shared/gateways.ts';
import { DiscordRecoveryView } from './gateway-discord-recovery.tsx';
import { GatewayInboxView } from './gateway-inbox.tsx';
import { WhatsAppSetupView } from './gateway-whatsapp-setup.tsx';
import type { GatewayHealth, GatewayInstance, GatewayTarget, GatewayTargets } from '../../shared/types.ts';

type Listed = GatewayInstance & { credentials: Record<string, boolean>; targetName?: string };
type Config = Omit<GatewayInstance, 'id' | 'createdAt' | 'updatedAt' | 'routeGeneration'>;
interface Listing { instances: Listed[]; health: GatewayHealth[] }
interface ProjectChoice { id: string; name: string }
const MiB = 1024 * 1024;
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not save this gateway. Try again.';
const lines = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
export function gatewayConfig(instance: GatewayInstance): Config {
  return { name: instance.name, platform: instance.platform, accountId: instance.accountId, projectId: instance.projectId, target: instance.target,
    senderPolicy: instance.senderPolicy, scope: instance.scope, fileLimits: instance.fileLimits, enabled: instance.enabled };
}

export function GatewaysTab() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [editor, setEditor] = useState<Listed | 'telegram' | 'slack' | 'discord' | 'whatsapp' | null>(null);
  const [relay, setRelay] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [inbox, setInbox] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false); const request = useRef(0); const linked = useRef(false);
  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const [gateways, all] = await Promise.all([GET<Listing>('/gateways'), GET<{ projects: ProjectChoice[] }>('/projects')]);
      if (!mounted.current || version !== request.current) return;
      setListing(gateways); setProjects(all.projects); setError('');
      if (!linked.current) {
        linked.current = true;
        const id = new URLSearchParams(location.hash.split('?')[1] || '').get('instance');
        if (id) { const found = gateways.instances.find((item) => item.id === id); if (found && (found.platform === 'whatsapp' || gatewayPlatformAvailable(found.platform))) setEditor(found); else setError('This gateway is unavailable. Choose an instance below.'); }
        const relayId = new URLSearchParams(location.hash.split('?')[1] || '').get('relay');
        if (relayId) { setEditor(null); setRelay(relayId); }
        const inboxId = new URLSearchParams(location.hash.split('?')[1] || '').get('inbox');
        if (inboxId) { setEditor(null); setInbox(inboxId); }
      }
    } catch (failure) { if (mounted.current && version === request.current) setError(message(failure)); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  useServerEvents((event) => { if (event.type === 'gateways' || event.type === 'gateway-health' || event.type === 'projects') void load(); });
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); await load(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const edit = (instance: Listed) => {
    setRecovery(null); setRelay(null); setInbox(null); setEditor(instance);
    history.replaceState(null, '', `#/settings?tab=gateways&instance=${encodeURIComponent(instance.id)}`);
  };
  const close = () => { setEditor(null); history.replaceState(null, '', '#/settings?tab=gateways'); };
  const closeInbox = () => { setInbox(null); history.replaceState(null, '', '#/settings?tab=gateways'); };
  const closeRelay = () => { setRelay(null); history.replaceState(null, '', '#/settings?tab=gateways'); };
  const panelOpen = editor !== null || recovery !== null || relay !== null;
  const recoveryInstance = listing?.instances.find((instance) => instance.id === recovery);
  const relayInstance = listing?.instances.find((instance) => instance.id === relay && instance.platform === 'whatsapp');
  const inboxInstance = listing?.instances.find((instance) => instance.id === inbox);
  return <div className="flex flex-col gap-10">
    <Section title="Chat gateways" description="Talk to the Brain, a team or an agent from a messaging app. Each instance has its own account, project and sender rules."
      action={<>{(['telegram', 'slack', 'discord', 'whatsapp'] as const).map((platform) => <Button key={platform} size="small" disabled={busy || !listing || panelOpen || !projects.length} onClick={() => { setRecovery(null); setRelay(null); setInbox(null); setEditor(platform); }}>Add {({ telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' })[platform]} instance</Button>)}</>}>
      {error && <div role="alert" className="px-5 py-4 text-red">{error} <Button size="tiny" variant="ghost" onClick={() => void load()}>Reload</Button></div>}
      {!listing ? <Row title={error ? 'Gateways could not load' : 'Loading gateways…'} /> : !listing.instances.length ? <Row title="No gateway instances yet" description="Add a messaging account, choose who answers, then set sender and conversation rules. WhatsApp setup is available while its connection is still in development." /> : listing.instances.map((instance) => {
        const health = listing.health.find((item) => item.instanceId === instance.id);
        const status = !instance.enabled ? 'Paused' : health?.status === 'connected' ? 'Connected' : health?.status === 'connecting' ? 'Connecting' : health?.status === 'retrying' ? 'Retrying' : 'Needs setup';
        const credentialsReady = instance.platform === 'whatsapp' ? instance.credentials.accessToken && instance.credentials.signingSecret && instance.credentials.relayKey : instance.credentials.botToken && (instance.platform !== 'slack' || instance.credentials.appToken);
        return <Row key={instance.id} title={<span className="flex flex-wrap items-center gap-2">{instance.name}<Pill tone={status === 'Connected' ? 'ok' : instance.enabled ? 'warn' : undefined}>{status}</Pill></span>}
          description={<span className="break-words">{instance.platform === 'telegram' ? 'Telegram' : instance.platform === 'slack' ? 'Slack' : instance.platform === 'discord' ? 'Discord' : 'WhatsApp'} · {projects.find((item) => item.id === instance.projectId)?.name || 'Project unavailable'} · {instance.targetName || (instance.target.kind === 'brain' ? 'The Brain' : instance.target.kind === 'team' ? 'Team' : 'Agent')}{(instance.platform === 'telegram' || instance.platform === 'discord') && !instance.credentials.botToken ? <span className="mt-1 block">Add a bot token before enabling.</span> : null}{instance.platform === 'slack' && (!instance.credentials.botToken || !instance.credentials.appToken) ? <span className="mt-1 block">Add bot and app tokens before enabling.</span> : null}{health?.reason ? <span className="mt-1 block">{health.reason}</span> : null}{health?.retryAt && health.retryAt > Date.now() ? <span className="mt-1 block">Next connection attempt after {new Date(health.retryAt).toLocaleString()}.</span> : null}</span>}>
          {(instance.platform === 'whatsapp' || gatewayPlatformAvailable(instance.platform)) && <Button size="small" variant="ghost" disabled={busy || panelOpen} onClick={() => edit(instance)}>Edit</Button>}
          {instance.platform === 'whatsapp' && <Button size="small" variant="ghost" disabled={busy || panelOpen} onClick={() => { setInbox(null); setRelay(instance.id); history.replaceState(null, '', `#/settings?tab=gateways&relay=${encodeURIComponent(instance.id)}`); }}>Set up relay</Button>}
          <Button size="small" variant="ghost" disabled={busy || panelOpen} onClick={() => { setRecovery(null); setRelay(null); setInbox(instance.id); history.replaceState(null, '', `#/settings?tab=gateways&inbox=${encodeURIComponent(instance.id)}`); }}>Inbox</Button>
          <Button size="small" variant="ghost" disabled={busy || panelOpen || (!instance.enabled && (!gatewayPlatformAvailable(instance.platform) || !credentialsReady))} onClick={() => void action(() => PUT(`/gateways/${instance.id}`, { ...gatewayConfig(instance), enabled: !instance.enabled }))}>{instance.enabled ? 'Pause' : 'Enable'}</Button>
          {instance.platform === 'discord' && (!instance.enabled || health?.recoveryRequired) && <Button size="small" variant="ghost" disabled={busy || panelOpen} onClick={() => { setInbox(null); setRecovery(instance.id); }}>Review recovery</Button>}
          {instance.enabled && <Button size="small" variant="ghost" disabled={busy || panelOpen} onClick={() => void action(() => POST(`/gateways/${instance.id}/reconnect`))}>Reconnect</Button>}
          <Button size="small" variant="danger" disabled={busy || panelOpen} onClick={() => void (async () => {
            if (await confirmBox(`Delete ${instance.name}? Its connection and token will be removed. Saved conversation receipts remain for recovery.`, { ok: 'Delete', danger: true })) await action(() => DEL(`/gateways/${instance.id}`));
          })()}>Delete</Button>
        </Row>;
      })}
      <PanelNote>Telegram, Slack and Discord are available for testing. WhatsApp setup is available, but receiving and sending remain disabled. Existing one-way notifications stay under Connections. Approvals are reviewed in Athena.</PanelNote>
    </Section>
    {editor && <GatewayEditor key={typeof editor === 'string' ? editor : editor.id} platform={typeof editor === 'string' ? editor : editor.platform} instance={typeof editor === 'string' ? null : editor} projects={projects} close={close} saved={async () => { close(); await load(); }} />}
    {recoveryInstance && <DiscordRecoveryView key={recoveryInstance.id} instance={recoveryInstance} close={() => setRecovery(null)} changed={load} />}
    {recovery && listing && !recoveryInstance && <Row title="This gateway is no longer available"><Button size="small" variant="ghost" onClick={() => setRecovery(null)}>Close recovery</Button></Row>}
    {relayInstance && <WhatsAppSetupView key={relayInstance.id} instance={relayInstance} close={closeRelay} changed={load} edit={() => edit(relayInstance)} pause={async () => { await PUT(`/gateways/${relayInstance.id}`, { ...gatewayConfig(relayInstance), enabled: false }); await load(); }} />}
    {relay && listing && !relayInstance && <Row title="This WhatsApp instance is no longer available"><Button size="small" variant="ghost" onClick={closeRelay}>Close setup</Button></Row>}
    {inboxInstance && <GatewayInboxView key={inboxInstance.id} instance={inboxInstance} close={closeInbox} />}
    {inbox && listing && !inboxInstance && <Row title="This gateway is no longer available"><Button size="small" variant="ghost" onClick={closeInbox}>Close inbox</Button></Row>}
  </div>;
}

function GatewayEditor({ instance, platform, projects, close, saved }: { instance: Listed | null; platform: GatewayInstance['platform']; projects: ProjectChoice[]; close: () => void; saved: () => Promise<void> }) {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [id, setId] = useState(instance?.id);
  const [config, setConfig] = useState<Config>(() => instance ? gatewayConfig(instance) : {
    name: '', platform, accountId: '', projectId: projects[0]?.id || '', target: { kind: 'brain' },
    senderPolicy: platform === 'whatsapp' ? { platform: 'whatsapp', allowedPhones: [] } : { platform: platform === 'discord' ? 'discord' : platform === 'slack' ? 'slack' : 'telegram', allowedUserIds: [] }, scope: { directMessages: true, conversationIds: [], guildIds: [] },
    fileLimits: { perFileBytes: 20 * MiB, perMessageBytes: 50 * MiB, filesPerMessage: 10, dailyBytes: 200 * MiB }, enabled: false,
  });
  const [senders, setSenders] = useState(instance ? ('allowedUserIds' in instance.senderPolicy ? instance.senderPolicy.allowedUserIds : instance.senderPolicy.allowedPhones).join('\n') : '');
  const [scope, setScope] = useState(instance?.scope.conversationIds.join('\n') || '');
  const slack = platform === 'slack'; const discord = platform === 'discord'; const whatsapp = platform === 'whatsapp';
  const [accessToken, setAccessToken] = useState(''); const [appSecret, setAppSecret] = useState('');
  const [removeAccess, setRemoveAccess] = useState(false); const [removeSecret, setRemoveSecret] = useState(false);
  const [guilds, setGuilds] = useState(instance?.scope.guildIds.join('\n') || '');
  const [appToken, setAppToken] = useState(''); const [removeAppToken, setRemoveAppToken] = useState(false);
  const [token, setToken] = useState(''); const [removeToken, setRemoveToken] = useState(false);
  const [targets, setTargets] = useState<GatewayTargets | null>(null);
  const [targetError, setTargetError] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; setTargets(null); setTargetError('');
    void GET<GatewayTargets>(`/gateways/targets/${encodeURIComponent(config.projectId)}`).then((value) => { if (active) setTargets(value); }).catch((failure: unknown) => { if (active) setTargetError(message(failure)); });
    return () => { active = false; };
  }, [config.projectId]);
  const patch = (value: Partial<Config>) => setConfig((before) => ({ ...before, ...value }));
  const accountLabel = whatsapp ? 'Business phone ID' : slack ? 'Workspace ID' : 'Bot account ID';
  const targetValue = config.target.kind === 'brain' ? 'brain' : `${config.target.kind}:${config.target.id}`;
  const options = [{ value: 'brain', label: 'The Brain' }, ...(targets?.teams || []).map((item) => ({ value: `team:${item.id}`, label: `Team · ${item.name}` })), ...(targets?.agents || []).map((item) => ({ value: `agent:${item.id}`, label: `Agent · ${item.name}` }))];
  if (!options.some((item) => item.value === targetValue)) options.push({ value: targetValue, label: 'Destination unavailable — choose another' });
  const submit = async () => {
    setBusy(true); setError(''); let configured = false;
    const body = { ...config, senderPolicy: whatsapp ? { platform: 'whatsapp', allowedPhones: lines(senders) } : { platform: discord ? 'discord' : slack ? 'slack' : 'telegram', allowedUserIds: lines(senders) }, scope: { ...config.scope, conversationIds: whatsapp ? [] : lines(scope), ...(discord ? { guildIds: lines(guilds) } : whatsapp ? { guildIds: [] } : {}) }, enabled: false };
    try {
      const record = id ? await PUT<GatewayInstance>(`/gateways/${id}`, body) : await POST<GatewayInstance>('/gateways', body);
      if (mounted.current) setId(record.id); configured = true;
      if (whatsapp) {
        const changes = { ...(removeAccess ? { accessToken: null } : accessToken.trim() ? { accessToken: accessToken.trim() } : {}), ...(removeSecret ? { signingSecret: null } : appSecret.trim() ? { signingSecret: appSecret.trim() } : {}) };
        if (Object.keys(changes).length) await POST(`/gateways/${record.id}/credentials`, changes);
      } else if (slack) {
        const changes = { ...(removeToken ? { botToken: null } : token.trim() ? { botToken: token.trim() } : {}), ...(removeAppToken ? { appToken: null } : appToken.trim() ? { appToken: appToken.trim() } : {}) };
        if (Object.keys(changes).length) await POST(`/gateways/${record.id}/credentials`, changes);
      } else if (removeToken || token.trim()) await PUT(`/gateways/${record.id}/credentials`, removeToken ? {} : { botToken: token.trim() });
      if (mounted.current) { setToken(''); setAppToken(''); setAccessToken(''); setAppSecret(''); toast('Gateway saved'); await saved(); }
    } catch (failure) { if (mounted.current) setError(`${configured ? 'The instance is saved paused. ' : ''}${message(failure)}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
      <Section title={instance ? `Edit ${instance.name}` : whatsapp ? 'New WhatsApp instance' : discord ? 'New Discord instance' : slack ? 'New Slack instance' : 'New Telegram instance'} description={whatsapp ? 'Save this instance, then choose Set up relay to pair and check it. Receiving and sending remain disabled while WhatsApp support is in development.' : 'Saving leaves this instance paused. Enable it above once setup is ready. Changing its project or destination holds earlier queued work for review.'}>
        <FieldRow label="Instance name"><input aria-label="Instance name" required maxLength={100} value={config.name} onChange={(event) => patch({ name: event.target.value })} /></FieldRow>
        <FieldRow label={accountLabel} hint={whatsapp ? 'The numeric phone-number ID from your Meta business account. Use a separate relay deployment for each business phone.' : discord ? 'The numeric bot user ID for your Discord app. Turn on Developer Mode in Discord to copy IDs.' : slack ? 'Slack workspace ID, starting with T. One workspace installation per instance.' : 'The numeric bot ID before the colon in its BotFather token. One bot account per instance.'}><input aria-label={accountLabel} className="font-mono" required inputMode={slack ? 'text' : 'numeric'} pattern={slack ? 'T[A-Z0-9]+' : whatsapp ? '[1-9][0-9]{0,29}' : discord ? '[1-9][0-9]{0,19}' : '[1-9][0-9]*'} disabled={Boolean(id)} value={config.accountId} onChange={(event) => patch({ accountId: event.target.value })} /></FieldRow>
        {!whatsapp && <>
        <FieldRow label="Bot token" hint={removeToken ? 'The saved token will be removed when you save.' : instance?.credentials.botToken ? 'A token is saved. Leave blank to keep it, or paste a replacement.' : discord ? 'Bot token from the Bot page in the Discord Developer Portal. It stays on this PC.' : slack ? 'Bot OAuth token (xoxb-) from your Slack app. It stays on this PC.' : 'Get a bot token from @BotFather. It stays on this PC and is never shown again.'}><input aria-label="Bot token" type="password" autoComplete="new-password" disabled={removeToken} value={token} onChange={(event) => setToken(event.target.value)} /></FieldRow>
        {instance?.credentials.botToken && <Row title="Saved token" description="Remove it on save, or keep the existing token."><Button type="button" variant="ghost" aria-pressed={removeToken} onClick={() => setRemoveToken((before) => !before)}>{removeToken ? 'Keep saved token' : 'Remove saved token'}</Button></Row>}
        </>}
        {whatsapp && ([
          { label: 'Access token', subject: 'access token', value: accessToken, remove: removeAccess, setValue: setAccessToken, setRemove: setRemoveAccess, saved: instance?.credentials.accessToken },
          { label: 'Meta app secret', subject: 'Meta app secret', value: appSecret, remove: removeSecret, setValue: setAppSecret, setRemove: setRemoveSecret, saved: instance?.credentials.signingSecret },
        ]).map((field) => <div key={field.label}>
          <FieldRow label={field.label} hint={field.remove ? 'The saved value will be removed on save.' : field.saved ? 'A value is saved. Leave blank to keep it, or paste a replacement.' : 'From your Meta business app. It stays on this computer and is never shown again.'}><input aria-label={field.label} type="password" autoComplete="new-password" disabled={field.remove} value={field.value} onChange={(event) => field.setValue(event.target.value)} /></FieldRow>
          {field.saved && <Row title={`Saved ${field.subject}`}><Button type="button" variant="ghost" aria-pressed={field.remove} onClick={() => field.setRemove((before) => !before)}>{field.remove ? `Keep saved ${field.subject}` : `Remove saved ${field.subject}`}</Button></Row>}
        </div>)}
        {slack && <>
          <FieldRow label="App token" hint={removeAppToken ? 'The saved app token will be removed when you save.' : instance?.credentials.appToken ? 'An app token is saved. Leave blank to keep it, or paste a replacement.' : 'App-level token (xapp-) with connections:write. Enable Socket Mode in the same Slack app.'}><input aria-label="App token" type="password" autoComplete="new-password" disabled={removeAppToken} value={appToken} onChange={(event) => setAppToken(event.target.value)} /></FieldRow>
          {instance?.credentials.appToken && <Row title="Saved app token" description="Change or remove this token separately from the bot token."><Button type="button" variant="ghost" aria-pressed={removeAppToken} onClick={() => setRemoveAppToken((before) => !before)}>{removeAppToken ? 'Keep saved app token' : 'Remove saved app token'}</Button></Row>}
        </>}
        <FieldRow label="Project" group="gateway-project"><SelectControl aria-label="Gateway project" value={config.projectId} options={projects.map((item) => ({ value: item.id, label: item.name }))} onChange={(projectId) => { patch({ projectId, target: { kind: 'brain' } }); }} /></FieldRow>
        <FieldRow label="Who answers" group="gateway-target" hint={targetError || (!targets ? 'Loading destinations…' : 'Each conversation gets a separate private history in this project.')}><SelectControl aria-label="Gateway destination" value={targetValue} options={options} onChange={(value) => { const at = value.indexOf(':'); const target: GatewayTarget = at < 0 ? { kind: 'brain' } : value.startsWith('team:') ? { kind: 'team', id: value.slice(at + 1) } : { kind: 'agent', id: value.slice(at + 1) }; patch({ target }); }} /></FieldRow>
        <FieldRow label={whatsapp ? 'Allowed phone numbers' : 'Allowed user IDs'} hint={whatsapp ? 'Full international numbers such as +436641234567, one per line. At least one is required before checking setup. Names, forwarded authors and number suffixes do not grant access.' : discord ? 'Optional numeric Discord user IDs, one per line. Empty allows any human who can message the bot or post in the selected channels. Bots and webhooks are refused.' : slack ? 'Optional Slack user IDs (U or W), one per line. Empty allows local workspace users within the configured scope. Bots and external users are refused.' : 'Numeric Telegram user IDs, one per line. An enabled instance requires at least one. Names and forwarded authors do not grant access.'} stack><textarea aria-label={whatsapp ? 'Allowed phone numbers' : 'Allowed user IDs'} className="font-mono" rows={3} value={senders} onChange={(event) => setSenders(event.target.value)} /></FieldRow>
        <Row title="Allow direct messages"><SelectControl aria-label="Allow direct messages" value={config.scope.directMessages ? 'yes' : 'no'} options={[{ value: 'yes', label: discord ? 'Users within sender rules' : slack ? 'Workspace users within sender rules' : 'Allowed users only' }, { value: 'no', label: 'No direct messages' }]} onChange={(value) => patch({ scope: { ...config.scope, directMessages: value === 'yes' } })} /></Row>
        {discord && <FieldRow label="Allowed servers" hint="Numeric server IDs, one per line. Required for server channels; direct messages use their own rule." stack><textarea aria-label="Allowed servers" className="font-mono" rows={3} value={guilds} onChange={(event) => setGuilds(event.target.value)} /></FieldRow>}
        {!whatsapp && <FieldRow label={discord ? 'Allowed channels and threads' : slack ? 'Allowed channels and threads' : 'Allowed groups and topics'} hint={discord ? 'Numeric channel or native thread IDs, one per line. A selected parent channel also allows its threads. List its server above. New channel topics need a bot mention or reply.' : slack ? 'One channel ID or channel ID/thread timestamp per line. Invite the bot to each channel. Start with a bot mention; continue in that thread. Shared channels and group DMs are refused.' : 'One chat ID or chat ID/topic ID per line, for example -100123/7. New shared conversations need a bot mention or reply.'} stack><textarea aria-label={discord ? 'Allowed channels and threads' : slack ? 'Allowed channels and threads' : 'Allowed groups and topics'} className="font-mono" rows={3} value={scope} onChange={(event) => setScope(event.target.value)} /></FieldRow>}
        {([['perFileBytes', 'File limit (MiB)', 20], ['perMessageBytes', 'Message limit (MiB)', 50], ['dailyBytes', 'Daily limit (MiB)', Math.floor(Number.MAX_SAFE_INTEGER / MiB)], ['filesPerMessage', 'Files per message', 10]] as const).map(([key, label, max]) => <FieldRow key={key} label={label}><input aria-label={label} type="number" min={key === 'filesPerMessage' ? 1 : 1 / MiB} max={max} step={key === 'filesPerMessage' ? 1 : 'any'} required value={key === 'filesPerMessage' ? config.fileLimits[key] : config.fileLimits[key] / MiB} onChange={(event) => patch({ fileLimits: { ...config.fileLimits, [key]: Math.round(Number(event.target.value) * (key === 'filesPerMessage' ? 1 : MiB)) } })} /></FieldRow>)}
        <PanelNote>Incoming and outgoing byte limits are tracked separately. The file limit must fit within the message limit, and the message limit within the daily limit. {whatsapp ? 'Pair the relay after saving. Replies need a fresh user message within 24 hours; selected text, PDF and Office files send as documents. Finish any pending pairing before changing credentials.' : discord ? 'Discord replies and files stay with the saved source message in its channel or thread. Keep Athena open to receive messages.' : slack ? 'Slack messages and files reply in the original thread. Direct messages also start a new thread; reply there to continue.' : 'Telegram polling requires a bot without an existing webhook; Athena will not delete one.'}</PanelNote>
        {discord && <PanelNote>In the Discord Developer Portal, enable the Message content intent on the Bot page. Invite the bot with the bot scope and View channels, Read message history, Send messages, Send messages in threads and Attach files permissions. No webhook URL or public Athena address is needed. Approvals stay in Athena.</PanelNote>}
        {slack && <PanelNote>In your Slack app, enable Socket Mode and subscribe to app_mention, message.channels, message.groups and message.im. Bot scopes: app_mentions:read, channels:history, channels:read, groups:history, groups:read, im:history, im:read, users:read, chat:write, files:read and files:write. Reinstall the app after changing scopes. Approvals stay in Athena.</PanelNote>}
        {error && <div role="alert" className="px-5 py-4 text-red">{error}</div>}
        <RowActions><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button type="submit" disabled={!targets || Boolean(targetError)}>{busy ? 'Saving…' : 'Save instance'}</Button></RowActions>
      </Section>
    </fieldset>
  </form>;
}
