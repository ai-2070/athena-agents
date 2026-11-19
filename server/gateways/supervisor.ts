// The gateways: keeps every enabled bot connected, takes in the messages its people send, runs each with the Brain, a
// team or an agent (run.ts) and sends the answer back, with any files the agent chose. Each message is saved before
// anything is done with it (store.ts), so a restart loses none: one that was being worked on is marked failed for you
// to retry (never run twice on its own), and a retry sends only what didn't arrive yet.
import { bus, emit, getGatewaySecrets, log } from '../store.ts';
import { newBatch, receiveSource } from '../uploads.ts';
import {
  addMessage,
  conversationOf,
  getChat,
  getInstance,
  getMessage,
  inInstanceProject,
  instanceProject,
  instances,
  listChats,
  listMessages,
  messageId,
  PLATFORM_NAME,
  readState,
  rememberChat,
  removeMessage,
  targetName,
  updateMessage,
  writeState,
} from './store.ts';
import { runGatewayMessage } from './run.ts';
import { DiscordTransport } from './discord.ts';
import { SlackTransport } from './slack.ts';
import { TelegramTransport } from './telegram.ts';
import { GatewaySetupError, pause } from './transport.ts';
import type { ChatRef, Incoming, Transport } from './transport.ts';
import type {
  GatewayFile,
  GatewayHealth,
  GatewayInstance,
  GatewayListing,
  GatewayMessage,
  GatewayPlatform,
  GatewayStatus,
  ServerEvent,
} from '../../shared/types.ts';

/** Biggest file taken in from a chat. */
const MAX_FILE = 100 * 1024 * 1024;
/** Messages one gateway works on at once (one at a time per chat). */
const AT_ONCE = 3;
/** Files an agent may send back with one answer. */
const MAX_OUT_FILES = 10;

const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Splits an answer into messages of at most max characters, at paragraph, line or word ends where it can. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    // (never between the two halves of an emoji)
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Whether the gateway listens to this message; refused tells what to show you so you can allow it. */
export function admits(
  instance: GatewayInstance,
  m: Incoming,
): { ok: true } | { ok: false; refused?: { kind: 'user' | 'channel'; id: string; name: string } } {
  if (m.sender.bot) return { ok: false };
  if (!m.chat.direct && !m.addressed) return { ok: false };
  const user = { kind: 'user' as const, id: m.sender.id, name: m.sender.name };
  if (instance.platform === 'telegram') {
    // (no list, no one: a Telegram bot can be found and written to by anybody)
    return instance.users.includes(m.sender.id) ? { ok: true } : { ok: false, refused: user };
  }
  if (instance.users.length && !instance.users.includes(m.sender.id)) return { ok: false, refused: user };
  if (m.chat.direct) {
    // (a Discord bot can be written to by anyone who shares a server with it: direct messages need the list)
    return instance.platform === 'discord' && !instance.users.length ? { ok: false, refused: user } : { ok: true };
  }
  const inList = [m.chat.chatId, m.chat.parentId].some((id) => !!id && instance.channels.includes(id));
  return inList
    ? { ok: true }
    : { ok: false, refused: { kind: 'channel', id: m.chat.parentId || m.chat.chatId, name: m.chat.title } };
}

const chatKeyOf = (chat: ChatRef) => (chat.threadId ? `${chat.chatId}:${chat.threadId}` : chat.chatId);
const chatOfKey = (key: string): ChatRef => {
  const [chatId, threadId] = key.split(':');
  return threadId ? { chatId, threadId } : { chatId };
};

interface Connection {
  key: string;
  transport: Transport;
  controller: AbortController;
  health: GatewayHealth;
}
type Refused = GatewayListing['refused'][number];

export class GatewaySupervisor {
  private readonly connections = new Map<string, Connection>();
  // messages being worked on, by id, and the conversation each runs in (send_gateway_files finds it by that)
  private readonly working = new Map<string, { instanceId: string; conversationId: string }>();
  private readonly refused = new Map<string, Refused[]>();
  private controller = new AbortController();
  private started = false;
  private readonly changed = (event: ServerEvent) => {
    // (an instance or its tokens changed)
    if (event.type === 'chat-gateways' || event.type === 'gateways') this.sync();
  };

  /** Connects every enabled gateway and picks up the messages a restart left. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.controller = new AbortController();
    for (const instance of instances.list())
      for (const m of listMessages(instance.id))
        if (m.status === 'working')
          updateMessage(instance.id, m.id, {
            status: 'failed',
            error: 'Athena stopped while it was working on this. Retry to run it again.',
          });
    bus.on('event', this.changed);
    this.sync();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    bus.off('event', this.changed);
    this.controller.abort();
    for (const id of [...this.connections.keys()]) this.disconnect(id);
  }

  // ---------- connections ----------
  private sync(): void {
    if (!this.started) return;
    const wanted = new Map(
      instances
        .list()
        .filter((i) => i.enabled)
        .map((i) => [i.id, i]),
    );
    for (const id of [...this.connections.keys()]) {
      const instance = wanted.get(id);
      if (!instance || this.connections.get(id)!.key !== keyOf(instance)) this.disconnect(id);
    }
    for (const instance of wanted.values()) {
      if (!this.connections.has(instance.id)) this.connect(instance);
      this.pump(instance.id);
    }
  }

  private disconnect(id: string): void {
    const c = this.connections.get(id);
    if (!c) return;
    c.controller.abort();
    this.connections.delete(id);
    emit('gateway-health', { id });
  }

  private connect(instance: GatewayInstance): void {
    let transport: Transport;
    try {
      transport = makeTransport(instance);
    } catch (e) {
      this.connections.set(instance.id, {
        key: keyOf(instance),
        transport: nothing,
        controller: new AbortController(),
        health: { status: 'error', error: errorText(e) },
      });
      emit('gateway-health', { id: instance.id });
      return;
    }
    const controller = new AbortController();
    const c: Connection = { key: keyOf(instance), transport, controller, health: { status: 'connecting' } };
    this.connections.set(instance.id, c);
    const set = (health: GatewayHealth) => {
      if (this.connections.get(instance.id) !== c) return;
      c.health = health;
      emit('gateway-health', { id: instance.id });
    };
    void (async () => {
      let wait = 2000;
      while (!controller.signal.aborted) {
        set({ status: 'connecting', ...(c.health.bot ? { bot: c.health.bot } : {}) });
        let connectedAt = 0;
        try {
          await transport.run(
            {
              onMessage: (m) => this.take(instance.id, m),
              onReady: (bot) => {
                connectedAt = Date.now();
                set({ status: 'connected', bot: bot || c.health.bot });
              },
            },
            controller.signal,
          );
          if (controller.signal.aborted) break;
        } catch (e) {
          if (controller.signal.aborted) break;
          set({ status: 'error', error: errorText(e), ...(c.health.bot ? { bot: c.health.bot } : {}) });
          // (a wrong token or a missing permission: waits for you to change it, or to press Reconnect)
          if (e instanceof GatewaySetupError) {
            log('gateway', `${instance.name}: ${errorText(e)}`);
            return;
          }
        }
        // (a connection that held a while starts over quickly; one that keeps failing waits longer each time)
        wait = connectedAt && Date.now() - connectedAt > 60_000 ? 2000 : Math.min(wait * 2, 120_000);
        await pause(wait, controller.signal);
      }
    })();
  }

  /** Connects again now (after a setup error, say). */
  reconnect(id: string): void {
    const instance = getInstance(id);
    if (!instance.enabled) fail('Turn it on first.');
    this.disconnect(id);
    if (this.started) this.connect(instance);
    this.pump(id);
  }

  health(id: string): GatewayHealth {
    return this.connections.get(id)?.health ?? { status: 'off' };
  }

  // ---------- messages in ----------
  private take(instanceId: string, m: Incoming): void {
    const instance = instances.get(instanceId);
    if (!instance?.enabled) return;
    const verdict = admits(instance, m);
    if (!verdict.ok) {
      if (verdict.refused) {
        const list = (this.refused.get(instanceId) || []).filter(
          (r) => !(r.kind === verdict.refused!.kind && r.id === verdict.refused!.id),
        );
        this.refused.set(instanceId, [{ ...verdict.refused, at: Date.now() }, ...list].slice(0, 10));
        emit('gateway-health', { id: instanceId });
      }
      return;
    }
    if (!m.text.trim() && !m.files.length) return;
    const chatKey = chatKeyOf(m.chat);
    const now = Date.now();
    rememberChat({
      key: chatKey,
      instanceId,
      chatId: m.chat.chatId,
      ...(m.chat.threadId ? { threadId: m.chat.threadId } : {}),
      title: m.chat.title,
      lastAt: now,
    });
    const added = addMessage({
      id: messageId(instanceId, chatKey, m.sourceId),
      instanceId,
      chatKey,
      chatTitle: m.chat.title,
      sourceId: m.sourceId,
      sender: { id: m.sender.id, name: m.sender.name },
      text: m.text,
      files: m.files.map((f) => ({ name: f.name, ...(f.size ? { size: f.size } : {}), ref: f.ref })),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });
    if (added) this.pump(instanceId);
  }

  /** Starts the next waiting messages: in order, one at a time in each chat. */
  private pump(instanceId: string): void {
    if (!this.started) return;
    const instance = instances.get(instanceId);
    if (!instance?.enabled) return;
    const list = listMessages(instanceId);
    const busyChats = new Set(list.filter((m) => m.status === 'working').map((m) => m.chatKey));
    let running = busyChats.size;
    for (const m of list) {
      if (running >= AT_ONCE) return;
      if (m.status !== 'queued' || busyChats.has(m.chatKey)) continue;
      busyChats.add(m.chatKey);
      running++;
      updateMessage(instanceId, m.id, { status: 'working' });
      // (the conversation is known before anything awaits: send_gateway_files may come at once)
      this.working.set(m.id, { instanceId, conversationId: conversationOf(instanceId, m.chatKey) });
      void this.work(instance, m.id);
    }
  }

  private async work(instance: GatewayInstance, id: string): Promise<void> {
    const signal = this.controller.signal;
    const chat = chatOfKey(getMessage(instance.id, id).chatKey);
    const conversationId = conversationOf(instance.id, getMessage(instance.id, id).chatKey);
    let transport = nothing;
    let typing: ReturnType<typeof setInterval> | undefined;
    try {
      transport = this.transportFor(instance);
      const shown = transport;
      typing = setInterval(() => void shown.typing?.(chat).catch(() => {}), 5000);
      void shown.typing?.(chat).catch(() => {});
      await inInstanceProject(instance, async (project) => {
        const files = await this.fetchFiles(instance.id, id, transport, signal);
        let message = getMessage(instance.id, id);
        if (message.answer === undefined) {
          const missing = files.filter((f) => f.error);
          const text = [message.text, ...missing.map((f) => `(${f.name} couldn't be fetched: ${f.error})`)]
            .filter(Boolean)
            .join('\n\n');
          const answer = await runGatewayMessage(
            {
              projectId: project.id,
              conversationId,
              target: getInstance(instance.id).target,
              text: text || '(files only)',
              attachments: files.flatMap((f) => (f.path && !f.error ? [f.path] : [])),
              from: `${PLATFORM_NAME[instance.platform]}: ${message.sender.name} (${message.sender.id})`,
            },
            signal,
          );
          message = updateMessage(instance.id, id, { answer });
        }
        await this.deliver(instance, message, transport);
      });
      if (listMessages(instance.id).some((m) => m.id === id))
        updateMessage(instance.id, id, { status: 'done', error: undefined });
    } catch (e) {
      // (removed meanwhile: nothing left to note it in)
      const before = listMessages(instance.id).find((m) => m.id === id);
      if (before && !signal.aborted) {
        updateMessage(instance.id, id, { status: 'failed', error: errorText(e) });
        // (once, not again on a retry: the person knows it didn't go through, and you see why in Settings)
        if (!before.error && !before.sentParts)
          await transport
            .send(
              chat,
              'Sorry, something went wrong with this message. It is waiting in Athena to be tried again.',
              before.sourceId,
            )
            .catch(() => {});
      }
    } finally {
      clearInterval(typing);
      this.working.delete(id);
      this.pump(instance.id);
    }
  }

  /** Saves the message's files into the project's uploads (each once; one that fails is noted and skipped). */
  private async fetchFiles(
    instanceId: string,
    id: string,
    transport: Transport,
    signal: AbortSignal,
  ): Promise<GatewayFile[]> {
    const files = getMessage(instanceId, id).files;
    if (!files.some((f) => !f.path && !f.error)) return files;
    const { batch } = newBatch();
    for (const f of files) {
      if (f.path || f.error || !f.ref) continue;
      try {
        if (f.size && f.size > MAX_FILE) throw new Error(`over ${MAX_FILE / 1024 / 1024} MB`);
        const res = await transport.download({ name: f.name, ref: f.ref, ...(f.size ? { size: f.size } : {}) }, signal);
        const saved = await receiveSource(res.body!, batch, f.name, {
          declaredBytes: Number(res.headers.get('content-length') || 0),
          maxBytes: MAX_FILE,
          signal,
        });
        f.path = saved.path;
        f.size = saved.size;
      } catch (e) {
        if (signal.aborted) throw e;
        f.error = errorText(e);
      }
    }
    return updateMessage(instanceId, id, { files }).files;
  }

  /** Sends the answer (what hasn't arrived yet), then the files the agent chose. */
  private async deliver(instance: GatewayInstance, message: GatewayMessage, transport: Transport): Promise<void> {
    const chat = chatOfKey(message.chatKey);
    const out = message.outFiles || [];
    const parts = splitText(message.answer || '', transport.maxText);
    if (!parts.length && !out.length) parts.push('(No answer)');
    for (let i = message.sentParts || 0; i < parts.length; i++) {
      await transport.send(chat, parts[i], i === 0 ? message.sourceId : undefined);
      updateMessage(instance.id, message.id, { sentParts: i + 1 });
    }
    const files = out.map((f) => ({ ...f }));
    let failed = '';
    for (const f of files) {
      if (f.sent || !f.path) continue;
      try {
        await transport.sendFile(chat, { path: f.path, name: f.name });
        f.sent = true;
        f.error = undefined;
      } catch (e) {
        f.error = errorText(e);
        failed ||= `${f.name} couldn't be sent: ${f.error}`;
      }
      updateMessage(instance.id, message.id, { outFiles: files });
    }
    if (failed) throw new Error(failed);
  }

  /** A connection for sending even while the live one is down (sending needs only the token). */
  private transportFor(instance: GatewayInstance): Transport {
    const live = this.connections.get(instance.id);
    return live && live.transport !== nothing ? live.transport : makeTransport(instance);
  }

  /** Tries a failed message again: what it already has (files, an answer, parts sent) is kept. */
  retry(instanceId: string, id: string): void {
    const instance = getInstance(instanceId);
    const message = getMessage(instanceId, id);
    if (message.status !== 'failed') fail('Only a failed message can be tried again.');
    if (!instance.enabled) fail('Turn the gateway on first.');
    // (the error stays until it works: the person isn't told twice)
    updateMessage(instanceId, id, {
      status: 'queued',
      files: message.files.map((f) => (f.path ? f : { ...f, error: undefined })),
    });
    this.pump(instanceId);
  }

  /** Lets a failed message go, so its chat moves on. */
  dismiss(instanceId: string, id: string): void {
    getInstance(instanceId);
    if (this.working.has(id)) fail('It is being worked on.');
    removeMessage(instanceId, id);
    this.pump(instanceId);
  }

  forgetRefused(instanceId: string, kind: 'user' | 'channel', id: string): void {
    const list = this.refused.get(instanceId) || [];
    this.refused.set(
      instanceId,
      list.filter((r) => !(r.kind === kind && r.id === id)),
    );
    emit('gateway-health', { id: instanceId });
  }

  // ---------- what agents and the Outbox send ----------
  /** send_gateway_files: files for the answer of the message being worked on in this conversation. */
  queueFiles(conversationId: string, files: { path: string; name: string }[]): number {
    const entry = [...this.working.entries()].find(([, w]) => w.conversationId === conversationId);
    if (!entry) fail('No message from a chat is being answered in this conversation now.');
    const [id, { instanceId }] = entry!;
    const message = updateMessage(instanceId, id, (m) => {
      const known = new Set((m.outFiles || []).map((f) => f.path));
      const next = [...(m.outFiles || []), ...files.filter((f) => !known.has(f.path))];
      if (next.length > MAX_OUT_FILES) fail(`At most ${MAX_OUT_FILES} files go with one answer.`);
      return { outFiles: next };
    });
    return message.outFiles!.length;
  }

  /** The Outbox: sends parts (from the first one not sent yet) to a chat the gateway knows. Gives how many arrived. */
  async sendToChat(
    instanceId: string,
    chatKey: string,
    parts: string[],
    from = 0,
    progress: (sent: number) => void = () => {},
  ): Promise<number> {
    const instance = getInstance(instanceId);
    getChat(instanceId, chatKey);
    const transport = this.transportFor(instance);
    const chat = chatOfKey(chatKey);
    let sent = from;
    for (; sent < parts.length; sent++) {
      for (const piece of splitText(parts[sent], transport.maxText)) await transport.send(chat, piece);
      progress(sent + 1);
    }
    return sent;
  }

  /** The chats the Outbox can send to: those the gateways of a project have talked in. */
  chats(
    projectId: string,
  ): { instanceId: string; instanceName: string; platform: GatewayPlatform; chatKey: string; title: string }[] {
    return instances
      .list()
      .filter((i) => i.projectId === projectId)
      .flatMap((i) =>
        listChats(i.id).map((c) => ({
          instanceId: i.id,
          instanceName: i.name,
          platform: i.platform,
          chatKey: c.key,
          title: c.title,
        })),
      );
  }

  // ---------- what the page sees ----------
  listing(): GatewayListing[] {
    return instances
      .list()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((instance) => {
        const secrets = getGatewaySecrets(instance.id);
        return {
          ...instance,
          projectName: instanceProject(instance)?.name ?? '(removed project)',
          targetName: targetName(instance) ?? '(gone)',
          credentials: { botToken: !!secrets.botToken, appToken: !!secrets.appToken },
          health: this.health(instance.id),
          refused: this.refused.get(instance.id) || [],
        };
      });
  }

  /** Messages, newest first, without the platforms' file handles. */
  messages(instanceId: string): GatewayMessage[] {
    getInstance(instanceId);
    return listMessages(instanceId)
      .reverse()
      .map((m) => ({ ...m, files: m.files.map(({ ref: _ref, ...f }) => f) }));
  }

  /** The sidebar's lines. */
  summary(): GatewayStatus[] {
    return instances.list().map((instance) => ({
      id: instance.id,
      name: instance.name,
      platform: instance.platform,
      projectName: instanceProject(instance)?.name ?? '',
      status: instance.enabled ? this.health(instance.id).status : 'off',
      failed: listMessages(instance.id).filter((m) => m.status === 'failed').length,
    }));
  }
}

const keyOf = (instance: GatewayInstance) => {
  const s = getGatewaySecrets(instance.id);
  return JSON.stringify([instance.platform, s.botToken || '', s.appToken || '']);
};

function makeTransport(instance: GatewayInstance): Transport {
  const s = getGatewaySecrets(instance.id);
  if (!s.botToken) throw new GatewaySetupError('Add the bot token.');
  if (instance.platform === 'telegram')
    return new TelegramTransport(s.botToken, {
      get: () => readState<{ offset: number }>(instance.id).offset,
      set: (offset) => writeState(instance.id, { ...readState(instance.id), offset }),
    });
  if (instance.platform === 'slack') {
    if (!s.appToken) throw new GatewaySetupError('Add the app-level token (xapp-…).');
    return new SlackTransport(s.botToken, s.appToken);
  }
  return new DiscordTransport(s.botToken);
}

// (stands in for a connection that couldn't be made)
const nothing: Transport = {
  maxText: 1000,
  run: () => Promise.resolve(),
  send: () => Promise.reject(new Error('Not connected.')),
  sendFile: () => Promise.reject(new Error('Not connected.')),
  download: () => Promise.reject(new Error('Not connected.')),
};

export const gateways = new GatewaySupervisor();
