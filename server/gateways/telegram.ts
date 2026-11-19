// Telegram through the Bot API: long polling (getUpdates), so nothing has to reach this computer from outside.
import { GatewaySetupError, fileBlob, isObject, readJson, str } from './transport.ts';
import type { ChatRef, Incoming, RemoteFile, Transport } from './transport.ts';

const API = 'https://api.telegram.org';
/** Bots may fetch files up to 20 MB. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;

type Json = Record<string, unknown>;

export class TelegramTransport implements Transport {
  readonly maxText = 4096;
  private readonly token: string;
  private readonly offset: { get(): number | undefined; set(value: number): void };
  private bot = { id: '', username: '' };

  constructor(token: string, offset: { get(): number | undefined; set(value: number): void }) {
    this.token = token;
    this.offset = offset;
  }

  private async call(method: string, body?: Json | FormData, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
      signal,
    });
    const data = await readJson(res);
    if (isObject(data) && data.ok === true) return data.result;
    const said = isObject(data) ? str(data.description) : '';
    if (res.status === 401 || res.status === 404) throw new GatewaySetupError('Telegram refused the bot token.');
    if (res.status === 409)
      throw new GatewaySetupError(
        'Another program reads this bot’s messages (a webhook, or Athena on another computer). Stop it there first.',
      );
    throw new Error(`Telegram: ${said || res.status}`);
  }

  async run(
    { onMessage, onReady }: { onMessage: (m: Incoming) => void; onReady: (bot: string) => void },
    signal: AbortSignal,
  ): Promise<void> {
    const me = await this.call('getMe', {}, signal);
    if (!isObject(me)) throw new Error('Telegram: no bot details.');
    this.bot = { id: str(me.id), username: str(me.username) };
    onReady(`@${this.bot.username}`);
    while (!signal.aborted) {
      const next = this.offset.get();
      const updates = await this.call(
        'getUpdates',
        { timeout: 30, allowed_updates: ['message'], ...(next !== undefined ? { offset: next } : {}) },
        signal,
      );
      if (!Array.isArray(updates)) continue;
      for (const update of updates) {
        if (!isObject(update)) continue;
        const incoming = isObject(update.message) ? this.incoming(update.message) : null;
        // (saved by onMessage before the offset moves past it, so a restart never loses one)
        if (incoming) onMessage(incoming);
        this.offset.set(Number(update.update_id) + 1);
      }
    }
  }

  private incoming(m: Json): Incoming | null {
    const chat = isObject(m.chat) ? m.chat : null;
    const from = isObject(m.from) ? m.from : null;
    if (!chat || !from) return null;
    const direct = chat.type === 'private';
    const text = str(m.text) || str(m.caption);
    const entities = [
      ...(Array.isArray(m.entities) ? m.entities : []),
      ...(Array.isArray(m.caption_entities) ? m.caption_entities : []),
    ].filter(isObject);
    const mention = `@${this.bot.username}`.toLowerCase();
    const mentioned = entities.some(
      (e) =>
        (e.type === 'mention' &&
          text.slice(Number(e.offset), Number(e.offset) + Number(e.length)).toLowerCase() === mention) ||
        (e.type === 'text_mention' && isObject(e.user) && str(e.user.id) === this.bot.id),
    );
    const reply = isObject(m.reply_to_message) && isObject(m.reply_to_message.from) ? m.reply_to_message.from : null;
    const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(' ') || str(from.username);
    const thread = m.is_topic_message === true ? str(m.message_thread_id) : '';
    return {
      sourceId: str(m.message_id),
      chat: {
        chatId: str(chat.id),
        ...(thread ? { threadId: thread } : {}),
        title: direct ? name : str(chat.title) || str(chat.id),
        direct,
      },
      sender: { id: str(from.id), name, bot: from.is_bot === true },
      text: mention.length > 1 ? text.replace(new RegExp(`${escape(mention)}\\b`, 'gi'), '').trim() : text,
      addressed: direct || mentioned || (!!reply && str(reply.id) === this.bot.id),
      files: files(m),
    };
  }

  async send(chat: ChatRef, text: string, replyTo?: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chat.chatId,
      text,
      ...(chat.threadId ? { message_thread_id: Number(chat.threadId) } : {}),
      ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  async sendFile(chat: ChatRef, file: { path: string; name: string }, replyTo?: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', chat.chatId);
    if (chat.threadId) form.set('message_thread_id', chat.threadId);
    if (replyTo)
      form.set('reply_parameters', JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true }));
    form.set('document', await fileBlob(file.path), file.name);
    await this.call('sendDocument', form);
  }

  async download(file: RemoteFile, signal: AbortSignal): Promise<Response> {
    if (file.size && file.size > MAX_DOWNLOAD) throw new Error('Over 20 MB, more than Telegram lets bots fetch.');
    const found = await this.call('getFile', { file_id: file.ref }, signal);
    const path = isObject(found) ? str(found.file_path) : '';
    if (!path || path.includes('..')) throw new Error('Telegram has no copy of this file.');
    const res = await fetch(`${API}/file/bot${this.token}/${path}`, { signal, redirect: 'error' });
    if (!res.ok || !res.body) throw new Error(`Telegram: the file download failed (${res.status}).`);
    return res;
  }

  async typing(chat: ChatRef): Promise<void> {
    await this.call('sendChatAction', {
      chat_id: chat.chatId,
      action: 'typing',
      ...(chat.threadId ? { message_thread_id: Number(chat.threadId) } : {}),
    });
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function files(m: Json): RemoteFile[] {
  const out: RemoteFile[] = [];
  const add = (f: unknown, fallback: string) => {
    if (!isObject(f) || !str(f.file_id)) return;
    out.push({
      name: str(f.file_name) || fallback,
      ...(typeof f.file_size === 'number' ? { size: f.file_size } : {}),
      ref: str(f.file_id),
    });
  };
  add(m.document, 'document');
  // (a photo comes in several sizes: the largest is last)
  if (Array.isArray(m.photo) && m.photo.length) add(m.photo[m.photo.length - 1], `photo-${str(m.message_id)}.jpg`);
  add(m.video, `video-${str(m.message_id)}.mp4`);
  add(m.audio, `audio-${str(m.message_id)}.mp3`);
  add(m.voice, `voice-${str(m.message_id)}.ogg`);
  add(m.video_note, `video-note-${str(m.message_id)}.mp4`);
  return out;
}
