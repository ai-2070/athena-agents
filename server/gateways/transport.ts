// What every chat app's connection does for the gateway (telegram.ts, slack.ts, discord.ts): bring in new messages,
// answer in a chat, send a file, fetch a file someone sent.
import fs from 'node:fs';

/** Where to answer: a chat, and a topic or thread inside it. */
export interface ChatRef {
  chatId: string;
  threadId?: string;
}

export interface RemoteFile {
  name: string;
  size?: number;
  /** The platform's handle for it: a Telegram file id or a download URL. */
  ref: string;
}

/** A new message as the gateway sees it, whatever the app. */
export interface Incoming {
  sourceId: string;
  chat: ChatRef & { title: string; direct: boolean; parentId?: string };
  sender: { id: string; name: string; bot: boolean };
  text: string;
  /** The bot was mentioned or replied to (always so in a direct message). */
  addressed: boolean;
  files: RemoteFile[];
}

export interface Transport {
  /** Longest text one message may hold. */
  readonly maxText: number;
  /** Connects, then hands each new message to onMessage until signal stops it. Calls onReady with the bot's name
   *  once connected. Returns or throws when the connection ends; the gateway reconnects. */
  run(
    handlers: { onMessage: (m: Incoming) => void; onReady: (bot: string) => void },
    signal: AbortSignal,
  ): Promise<void>;
  send(chat: ChatRef, text: string, replyTo?: string): Promise<void>;
  sendFile(chat: ChatRef, file: { path: string; name: string }, replyTo?: string): Promise<void>;
  /** The file's bytes, as a response to stream from. */
  download(file: RemoteFile, signal: AbortSignal): Promise<Response>;
  /** Shows "typing…" for a few seconds, where the app has it. */
  typing?(chat: ChatRef): Promise<void>;
}

/** A connection that can't work until you change something (a wrong token): no point retrying it. */
export class GatewaySetupError extends Error {}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The app answered ${res.status} without JSON.`);
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Waits ms, or less when signal stops it. */
export const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    }
    signal.addEventListener('abort', finish, { once: true });
  });

/** A file as a part of a form upload. */
export async function fileBlob(file: string): Promise<Blob> {
  return new Blob([await fs.promises.readFile(file)]);
}
