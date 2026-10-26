// Files a chat message mentions: absolute paths in its text (Windows or Mac/Linux), quoted or in
// backticks (those may have spaces), markdown links and file:// links. Web links are not files.
// The server then says which of them are really there and may be shown (POST /api/files/info).

const EXT = String.raw`\.[A-Za-z0-9]{1,8}`;
// with spaces: inside `…`, "…", '…', (…) of a markdown link, or <…>
const QUOTED = new RegExp(String.raw`[\x60"'(<]((?:[A-Za-z]:[\\/]|/)[^\x60"'<>()\r\n|*?]*?${EXT})[\x60"')>]`, 'g');
// without spaces, anywhere: C:\a\b.png, C:/a/b.png, /home/me/b.png (not the end of a web link)
const WIN = new RegExp(String.raw`(?<![\w/\\.])[A-Za-z]:[\\/](?:[^\s"'\x60<>|*?()\[\]\\/\r\n]+[\\/])*[^\s"'\x60<>|*?()\[\]\\/\r\n]+?${EXT}(?![\w\\/])`, 'g');
const POSIX = new RegExp(String.raw`(?<![\w.:/\\~-])/(?:[^\s"'\x60<>()\[\]/\r\n]+/)*[^\s"'\x60<>()\[\]/\r\n]+?${EXT}(?![\w/])`, 'g');
const FILE_URL = /file:\/\/\/?([^\s"'`<>()]+)/gi;

/** The absolute file paths a message mentions, in order, each once (at most max). */
export function findFileMentions(text: string | null | undefined, max = 12): string[] {
  const s = String(text || '');
  if (!s) return [];
  const found: { at: number; path: string }[] = [];
  const add = (at: number, p: string) => {
    const clean = p.trim().replace(/[.,;:!?]+$/, '');
    if (clean) found.push({ at, path: clean });
  };
  for (const m of s.matchAll(FILE_URL)) {
    let p = m[1];
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep as written */
    }
    // file:///C:/x → C:/x ; file:///home/x → /home/x
    add(m.index!, /^[A-Za-z]:[\\/]/.test(p) ? p : `/${p.replace(/^\/+/, '')}`);
  }
  // what file:// links used is taken; the rest is looked at for bare paths
  const rest = s.replace(FILE_URL, (m) => ' '.repeat(m.length));
  for (const m of rest.matchAll(QUOTED)) add(m.index! + 1, m[1]);
  for (const re of [WIN, POSIX]) for (const m of rest.matchAll(re)) add(m.index!, m[0]);
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { path } of found) {
    const key = path.replace(/\\/g, '/').toLowerCase();
    // a path inside a longer one already taken (C:\My Files\a.png found quoted and as "Files\a.png")
    if (seen.has(key) || out.some((o) => o.replace(/\\/g, '/').toLowerCase().endsWith(key))) continue;
    seen.add(key);
    out.push(path);
    if (out.length >= max) break;
  }
  return out;
}
