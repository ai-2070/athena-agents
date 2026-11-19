// Slack through Socket Mode: the app-level token (xapp-) opens a WebSocket for events, the bot token (xoxb-) answers.
// Direct messages and @mentions in channels; an answer in a channel goes into the message's thread.
import WebSocket from 'ws';
import { GatewaySetupError, fileBlob, isObject, readJson, str } from './transport.ts';
import type { ChatRef, Incoming, RemoteFile, Transport } from './transport.ts';

const API = 'https://slack.com/api';

type Json = Record<string, unknown>;

export class SlackTransport implements Transport {
  // (Slack takes far more, but splits long text badly)
  readonly maxText = 3900;
  private readonly botToken: string;
  private readonly appToken: string;
  private botUser = '';
  private readonly names = new Map<string, string>();
  // (each event waits for the one before: a name lookup must not let a later message overtake an earlier one)
  private order: Promise<unknown> = Promise.resolve();

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  private async call(method: string, body: Json, token = this.botToken, signal?: AbortSignal): Promise<Json> {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      // (form fields: every method takes them, not every one takes JSON)
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ),
      signal,
    });
    const data = await readJson(res);
    if (isObject(data) && data.ok === true) return data;
    const error = isObject(data) ? str(data.error) : String(res.status);
    if (['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'].includes(error))
      throw new GatewaySetupError(
        token === this.appToken ? 'Slack refused the app-level token.' : 'Slack refused the bot token.',
      );
    if (error === 'missing_scope')
      throw new GatewaySetupError(`The Slack app is missing a permission for ${method}. Check its scopes.`);
    throw new Error(`Slack: ${error}`);
  }

  async run(
    { onMessage, onReady }: { onMessage: (m: Incoming) => void; onReady: (bot: string) => void },
    signal: AbortSignal,
  ): Promise<void> {
    const me = await this.call('auth.test', {}, this.botToken, signal);
    this.botUser = str(me.user_id);
    const opened = await this.call('apps.connections.open', {}, this.appToken, signal);
    const url = str(opened.url);
    if (!url.startsWith('wss://')) throw new Error('Slack gave no connection address.');
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const stop = () => ws.close();
      signal.addEventListener('abort', stop, { once: true });
      ws.on('message', (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!isObject(data)) return;
        if (data.type === 'hello') onReady(`@${str(me.user)} in ${str(me.team)}`);
        // (Slack asks for a fresh connection now and then)
        else if (data.type === 'disconnect') ws.close();
        else if (data.envelope_id) {
          // acknowledged at once: Slack sends it again when it isn't, and the gateway keeps its own copy anyway
          ws.send(JSON.stringify({ envelope_id: data.envelope_id }));
          if (data.type === 'events_api' && isObject(data.payload) && isObject(data.payload.event)) {
            const event = data.payload.event;
            this.order = this.order.then(() => this.incoming(event).then((m) => m && onMessage(m))).catch(() => {});
          }
        }
      });
      ws.on('close', () => {
        signal.removeEventListener('abort', stop);
        resolve();
      });
      ws.on('error', (e) => reject(e));
    });
  }

  private async incoming(e: Json): Promise<Incoming | null> {
    const direct = e.channel_type === 'im';
    // a channel message arrives as app_mention; a direct one as a message (only new ones and file shares)
    if (e.type === 'message' ? !direct : e.type !== 'app_mention') return null;
    if (e.subtype && e.subtype !== 'file_share') return null;
    const user = str(e.user);
    if (!user || user === this.botUser) return null;
    const channel = str(e.channel);
    const ts = str(e.ts);
    const thread = str(e.thread_ts) || (direct ? '' : ts);
    const name = await this.lookup(`u:${user}`, () =>
      this.call('users.info', { user }).then((r) =>
        isObject(r.user)
          ? str(isObject(r.user.profile) ? r.user.profile.display_name : '') ||
            str(r.user.real_name) ||
            str(r.user.name)
          : '',
      ),
    );
    const title = direct
      ? name || user
      : `#${
          (await this.lookup(`c:${channel}`, () =>
            this.call('conversations.info', { channel }).then((r) => (isObject(r.channel) ? str(r.channel.name) : '')),
          )) || channel
        }`;
    return {
      sourceId: ts,
      chat: { chatId: channel, ...(thread ? { threadId: thread } : {}), title, direct },
      sender: { id: user, name: name || user, bot: !!e.bot_id },
      text: str(e.text)
        .replace(new RegExp(`<@${this.botUser}>`, 'g'), '')
        .trim(),
      addressed: true,
      files: (Array.isArray(e.files) ? e.files : []).filter(isObject).flatMap((f) =>
        str(f.url_private_download)
          ? [
              {
                name: str(f.name) || 'file',
                ...(typeof f.size === 'number' ? { size: f.size } : {}),
                ref: str(f.url_private_download),
              },
            ]
          : [],
      ),
    };
  }

  // Names are nice to have: without users:read or channels:read the ids stand in.
  private async lookup(key: string, find: () => Promise<string>): Promise<string> {
    if (this.names.has(key)) return this.names.get(key)!;
    const found = await find().catch(() => '');
    this.names.set(key, found);
    return found;
  }

  async send(chat: ChatRef, text: string): Promise<void> {
    await this.call('chat.postMessage', {
      channel: chat.chatId,
      text,
      ...(chat.threadId ? { thread_ts: chat.threadId } : {}),
      unfurl_links: false,
    });
  }

  async sendFile(chat: ChatRef, file: { path: string; name: string }): Promise<void> {
    const blob = await fileBlob(file.path);
    const target = await this.call('files.getUploadURLExternal', { filename: file.name, length: blob.size });
    const res = await fetch(str(target.upload_url), { method: 'POST', body: blob });
    if (!res.ok) throw new Error(`Slack: the upload failed (${res.status}).`);
    await this.call('files.completeUploadExternal', {
      files: [{ id: str(target.file_id), title: file.name }],
      channel_id: chat.chatId,
      ...(chat.threadId ? { thread_ts: chat.threadId } : {}),
    });
  }

  async download(file: RemoteFile, signal: AbortSignal): Promise<Response> {
    let url = new URL(file.ref);
    // (the token goes only to Slack's own file hosts, also when it sends us on to another)
    for (let hops = 0; ; hops++) {
      if (url.protocol !== 'https:' || !/(^|\.)(slack\.com|slack-edge\.com)$/.test(url.hostname))
        throw new Error('That file is not on Slack.');
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.botToken}` },
        signal,
        redirect: 'manual',
      });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (next && hops < 3) {
        url = new URL(next, url);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`Slack: the file download failed (${res.status}).`);
      // (without files:read Slack answers with its sign-in page)
      if ((res.headers.get('content-type') || '').startsWith('text/html'))
        throw new Error('Slack would not hand over the file: the app needs the files:read permission.');
      return res;
    }
  }
}
