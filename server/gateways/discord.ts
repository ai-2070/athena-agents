// Discord through its Gateway (a WebSocket: heartbeats, and a resume after a dropped connection) and its REST API.
// Direct messages and @mentions in the channels you list (threads in them too).
import WebSocket from 'ws';
import { GatewaySetupError, fileBlob, isObject, pause, readJson, str } from './transport.ts';
import type { ChatRef, Incoming, RemoteFile, Transport } from './transport.ts';

const API = 'https://discord.com/api/v10';
// GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const FATAL: Record<number, string> = {
  4004: 'Discord refused the bot token.',
  4010: 'Discord refused the connection (invalid shard).',
  4011: 'This bot is in too many servers for one connection.',
  4012: 'Discord refused the connection (API version).',
  4013: 'Discord refused the connection (invalid intents).',
  4014: 'Turn on Message Content Intent for the bot (Developer Portal › Bot), then reconnect.',
};

type Json = Record<string, unknown>;

export class DiscordTransport implements Transport {
  readonly maxText = 2000;
  private readonly token: string;
  private botId = '';
  // what a dropped connection resumes with
  private session: { id: string; url: string; seq: number | null } | null = null;
  private readonly channels = new Map<string, { name: string; parentId: string }>();
  // (each message waits for the one before: a channel lookup must not let a later one overtake an earlier one)
  private order: Promise<unknown> = Promise.resolve();

  constructor(token: string) {
    this.token = token;
  }

  private async call(method: string, route: string, body?: Json | FormData, signal?: AbortSignal): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      const res = await fetch(`${API}${route}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
        signal,
      });
      if (res.status === 204) return null;
      const data = await readJson(res);
      if (res.ok) return data;
      if (res.status === 429 && tries < 3 && isObject(data)) {
        await pause(Math.min(30, Number(data.retry_after) || 1) * 1000, signal ?? new AbortController().signal);
        continue;
      }
      if (res.status === 401) throw new GatewaySetupError('Discord refused the bot token.');
      const said = isObject(data) ? str(data.message) : '';
      if (res.status === 403)
        throw new Error(`Discord: the bot isn't allowed to do that here${said ? ` (${said})` : ''}.`);
      throw new Error(`Discord: ${said || res.status}`);
    }
  }

  async run(
    { onMessage, onReady }: { onMessage: (m: Incoming) => void; onReady: (bot: string) => void },
    signal: AbortSignal,
  ): Promise<void> {
    const resume = this.session;
    let url = resume?.url;
    if (!url) {
      const found = await this.call('GET', '/gateway/bot', undefined, signal);
      url = isObject(found) ? str(found.url) : '';
    }
    if (!url.startsWith('wss://')) throw new Error('Discord gave no connection address.');
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    let beat: ReturnType<typeof setInterval> | undefined;
    let acked = true;
    const sendOp = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
    const heartbeat = () => {
      // (no answer to the last one: the connection is dead even if it looks open)
      if (!acked) return ws.close(4000);
      acked = false;
      sendOp(1, this.session?.seq ?? null);
    };
    await new Promise<void>((resolve, reject) => {
      const stop = () => ws.close(1000);
      signal.addEventListener('abort', stop, { once: true });
      ws.on('message', (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!isObject(data)) return;
        const d = isObject(data.d) ? data.d : {};
        if (typeof data.s === 'number' && this.session) this.session.seq = data.s;
        switch (data.op) {
          case 10: {
            const every = Number(d.heartbeat_interval) || 41250;
            beat = setInterval(heartbeat, every);
            if (resume) sendOp(6, { token: this.token, session_id: resume.id, seq: resume.seq });
            else
              sendOp(2, {
                token: this.token,
                intents: INTENTS,
                properties: { os: process.platform, browser: 'athena', device: 'athena' },
              });
            break;
          }
          case 11:
            acked = true;
            break;
          case 1:
            sendOp(1, this.session?.seq ?? null);
            break;
          // reconnect: the session resumes; an invalid one starts over
          case 7:
            ws.close(4000);
            break;
          case 9:
            if (data.d !== true) this.session = null;
            ws.close(4000);
            break;
          case 0:
            if (data.t === 'READY') {
              const user = isObject(d.user) ? d.user : {};
              this.botId = str(user.id);
              this.session = {
                id: str(d.session_id),
                url: str(d.resume_gateway_url),
                seq: typeof data.s === 'number' ? data.s : null,
              };
              onReady(`@${str(user.username)}`);
            } else if (data.t === 'RESUMED') onReady('');
            else if (data.t === 'MESSAGE_CREATE')
              this.order = this.order.then(() => this.incoming(d).then((m) => m && onMessage(m))).catch(() => {});
        }
      });
      ws.on('close', (code) => {
        clearInterval(beat);
        signal.removeEventListener('abort', stop);
        if (FATAL[code]) {
          this.session = null;
          reject(new GatewaySetupError(FATAL[code]));
        } else resolve();
      });
      ws.on('error', (e) => reject(e));
    });
  }

  private async incoming(m: Json): Promise<Incoming | null> {
    const author = isObject(m.author) ? m.author : null;
    if (!author || str(author.id) === this.botId) return null;
    // (0: an ordinary message, 19: a reply)
    if (m.type !== 0 && m.type !== 19) return null;
    const direct = !m.guild_id;
    const channelId = str(m.channel_id);
    const channel = direct ? { name: '', parentId: '' } : await this.channel(channelId);
    const mentions = Array.isArray(m.mentions) ? m.mentions.filter(isObject) : [];
    const replied =
      isObject(m.referenced_message) && isObject(m.referenced_message.author)
        ? str(m.referenced_message.author.id)
        : '';
    const name = str(author.global_name) || str(author.username);
    return {
      sourceId: str(m.id),
      chat: {
        chatId: channelId,
        title: direct ? name : `#${channel.name || channelId}`,
        direct,
        ...(channel.parentId ? { parentId: channel.parentId } : {}),
      },
      sender: { id: str(author.id), name, bot: author.bot === true },
      text: str(m.content)
        .replace(new RegExp(`<@!?${this.botId}>`, 'g'), '')
        .trim(),
      addressed: direct || replied === this.botId || mentions.some((u) => str(u.id) === this.botId),
      files: (Array.isArray(m.attachments) ? m.attachments : []).filter(isObject).map((a) => ({
        name: str(a.filename) || 'file',
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
        ref: str(a.url),
      })),
    };
  }

  /** A channel's name, and the channel a thread is in (the one you list). */
  private async channel(id: string): Promise<{ name: string; parentId: string }> {
    const known = this.channels.get(id);
    if (known) return known;
    const found = await this.call('GET', `/channels/${id}`).catch(() => null);
    const value = isObject(found)
      ? { name: str(found.name), parentId: [10, 11, 12].includes(Number(found.type)) ? str(found.parent_id) : '' }
      : { name: '', parentId: '' };
    this.channels.set(id, value);
    return value;
  }

  async send(chat: ChatRef, text: string, replyTo?: string): Promise<void> {
    await this.call('POST', `/channels/${chat.chatId}/messages`, {
      content: text,
      allowed_mentions: { parse: [] },
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    });
  }

  async sendFile(chat: ChatRef, file: { path: string; name: string }, replyTo?: string): Promise<void> {
    const form = new FormData();
    form.set(
      'payload_json',
      JSON.stringify({
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename: file.name }],
        ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      }),
    );
    form.set('files[0]', await fileBlob(file.path), file.name);
    await this.call('POST', `/channels/${chat.chatId}/messages`, form);
  }

  async download(file: RemoteFile, signal: AbortSignal): Promise<Response> {
    const url = new URL(file.ref);
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname))
      throw new Error('That file is not on Discord.');
    const res = await fetch(url, { signal, redirect: 'error' });
    if (!res.ok || !res.body) throw new Error(`Discord: the file download failed (${res.status}).`);
    return res;
  }

  async typing(chat: ChatRef): Promise<void> {
    await this.call('POST', `/channels/${chat.chatId}/typing`);
  }
}
