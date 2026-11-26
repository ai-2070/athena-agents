// fetch_url's reading: a page as Markdown, in parts, kept for a while so the next part isn't downloaded again.
import { agentFetch } from './agentfetch.ts';

export const PAGE_CHARS = 20_000;
export const PAGE_MAX_CHARS = 50_000;
const BODY_BYTES = 5 * 1024 * 1024;
const KEPT_MS = 10 * 60_000;
const KEPT_PAGES = 20;

export interface Page {
  status: number;
  url: string;
  type: string;
  text: string;
  /** The body went past the byte limit and was cut there. */
  cut: boolean;
}

const pages = new Map<string, { at: number; page: Page }>();

/** The page for this reader (a run, or an agent outside one): fetched once, then kept for ten minutes. */
export async function readPage(url: string, reader: string, signal?: AbortSignal): Promise<Page> {
  const key = `${reader}\n${url}`;
  const kept = pages.get(key);
  if (kept && Date.now() - kept.at < KEPT_MS) return kept.page;
  // (never the dashboard itself, not even through a redirect)
  const { res, url: final } = await agentFetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) athena-agents/1.0.3' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const type = res.headers.get('content-type') || '';
  const { text, cut } = await bodyText(res);
  const page: Page = {
    status: res.status,
    url: final,
    type,
    cut,
    text: /html/i.test(type) ? htmlToMarkdown(text, final) : text,
  };
  if (!isText(type) && type) page.text = `This is a ${type.split(';')[0]} file, not text: fetch_url reads text only.`;
  pages.delete(key);
  pages.set(key, { at: Date.now(), page });
  for (const k of pages.keys()) if (pages.size > KEPT_PAGES) pages.delete(k);
  return page;
}

/** One part of a page's text, with where the next part starts. */
export function pagePart(page: Page, offset = 0, max = PAGE_CHARS): string {
  const most = Math.min(Math.max(1000, Math.floor(Number(max) || PAGE_CHARS)), PAGE_MAX_CHARS);
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), page.text.length);
  const end = Math.min(page.text.length, start + most);
  const head = `HTTP ${page.status} ${page.url}`;
  const note = [
    start > 0 || end < page.text.length
      ? `Characters ${start}-${end} of ${page.text.length}.${end < page.text.length ? ` Continue with offset ${end}.` : ''}`
      : '',
    page.cut ? `The page is larger than ${BODY_BYTES / 1024 / 1024} MB: only its start was read.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${head}\n\n${page.text.slice(start, end)}${note ? `\n\n[${note}]` : ''}`;
}

const isText = (type: string): boolean =>
  /^(text\/|application\/(json|xml|xhtml|rss|atom|javascript|ld\+json|[\w.+-]*\+(json|xml)))/i.test(type);

async function bodyText(res: Response): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: '', cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= BODY_BYTES) {
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(size, BODY_BYTES));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.length, all.length - at));
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return { text: new TextDecoder().decode(all), cut };
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const inline = (s: string): string =>
  decode(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** Readable Markdown from a page: headings, lists, links and code kept; scripts, menus and footers left out. */
export function htmlToMarkdown(html: string, base = ''): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const code: string[] = [];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|noscript|svg|head|nav|footer|aside|form|iframe|template|select|button)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    // code blocks keep their own spacing: put aside until the end
    .replace(
      /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, body: string) => `\n\n\u0000${code.push(decode(body.replace(/<[^>]+>/g, ''))) - 1}\u0000\n\n`,
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${inline(t)}\n\n`,
    )
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
      const text = inline(t);
      if (!text) return '';
      if (/^(#|javascript:|mailto:)/i.test(href)) return text;
      let link = decode(href);
      try {
        link = new URL(link, base || undefined).href;
      } catch {
        /* kept as written */
      }
      return `[${text}](${link})`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${inline(t)}\``)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|tr|section|article|header|main|ul|ol|table|blockquote|dl|dt|dd|figure|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${code[Number(i)]!.replace(/^\n+|\s+$/g, '')}\n\`\`\``);
  return (title ? `Title: ${inline(title)}\n\n` : '') + s;
}

/** For tests. */
export function forgetPages(): void {
  pages.clear();
}
