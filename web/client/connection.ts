// Where the dashboard's server is and how the page reaches it. Every address, request header and socket
// the page uses is built here, so reaching the server another way (a paired phone, later) is one change.

export interface Connection {
  /** The server's address, like 'http://127.0.0.1:4800'. Empty: the address the page came from. */
  base: string;
  /** Headers every request sends. */
  headers: Record<string, string>;
}

// x-dash: the server refuses changes without it (cross-site requests can't send it)
const DEFAULT: Connection = { base: '', headers: { 'x-dash': '1' } };
const conn: Connection = { base: DEFAULT.base, headers: { ...DEFAULT.headers } };

/** Changes where and how the page reaches its server. With no argument, back to the default. */
export function setConnection(next: Partial<Connection> = DEFAULT): void {
  if (next.base !== undefined) conn.base = next.base.replace(/\/+$/, '');
  if (next.headers) conn.headers = { ...next.headers };
}

/** The project the page shows: changes carry it, and the server refuses them once another project is open
 *  (a form loaded from one project can't be saved into the next). */
export function setPageProject(id: string | null | undefined): void {
  if (id) conn.headers['x-dash-project'] = id;
  else delete conn.headers['x-dash-project'];
}

/** A copy of the headers every request sends. */
export const requestHeaders = (): Record<string, string> => ({ ...conn.headers });

/** Query values; null and undefined are left out. */
export type Query = Record<string, string | number | boolean | null | undefined>;

// encodeURIComponent, not URLSearchParams: a space stays %20, as the code reading these back expects
const queryString = (query?: Query): string =>
  Object.entries(query || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/** The address of a path on the server ('/oauth/x/start'), with an optional query. */
export function serverUrl(path: string, query?: Query): string {
  const q = queryString(query);
  return `${conn.base}${path}${q ? (path.includes('?') ? '&' : '?') + q : ''}`;
}

/** The path prefix for a project that isn't open: '/p/<project>' ('' for none). The server runs a request sent there
 *  in that project (an Overview pane of another project's chat, terminal or Brain). */
export const projectAt = (projectId?: string | null): string => (projectId ? `/p/${encodeURIComponent(projectId)}` : '');

/** An API address: apiUrl('/agents') is '/api/agents'. */
export const apiUrl = (path: string, query?: Query): string => serverUrl(`/api${path}`, query);

// Where each project's folder is (from the page's state), so a file of a project that isn't open (a chat of it in an
// Overview pane) is shown and looked up through that project: the server only shows the open project's files.
let folders: { id: string; folder: string }[] = [];
let openProjectId = '';
const folderOf = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** The page's projects and which one is open (core.ts keeps this current). */
export function setProjectFolders(list: readonly { id: string; brainPath?: string }[], open: string | null | undefined): void {
  folders = list.flatMap((p) => (p.brainPath ? [{ id: p.id, folder: folderOf(p.brainPath) }] : [])).sort((a, b) => b.folder.length - a.folder.length);
  openProjectId = open || '';
}
/** '/p/<project>' for a file inside a project that isn't open (the longest folder that holds it), else ''.
 *  project: whose chat it is in (an Overview pane): a file outside every project's folder (an agent's own workspace,
 *  a tool's image) is looked up in that project. */
export function filesAt(path: string, project?: string): string {
  const p = folderOf(path);
  const hit = folders.find((f) => p === f.folder || p.startsWith(`${f.folder}/`));
  const id = hit ? hit.id : project || '';
  return id && id !== openProjectId ? projectAt(id) : '';
}

/** A file the server hands out (attachments, images, artifacts), for src and href. project: as for filesAt. */
export const fileUrl = (path: string, project?: string): string => apiUrl(`${filesAt(path, project)}/file`, { path });
/** A PDF to read in a browser tab (fileUrl downloads it). */
export const pdfViewUrl = (path: string, project?: string): string => apiUrl(`${filesAt(path, project)}/file`, { path, view: 1 });
/** An address the server wrote into a tool result ('/api/file?path=…': a tool's image), for a chat of a project that
 *  may not be open: there it is that project's. */
export function fileSrc(src: string, project?: string): string {
  const m = /^\/api\/file\?(.*)$/s.exec(src);
  if (!m) return src;
  const path = new URLSearchParams(m[1]).get('path') || '';
  return serverUrl(`/api${filesAt(path, project)}/file?${m[1]}`);
}

/** The ws:// (or wss://) address of a path on the server. */
export function socketUrl(path: string, query?: Query): string {
  const url = new URL(serverUrl(path, query), location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** A WebSocket to a path on the server: '/ws' for live events, '/ws/term' for a terminal. */
export const openSocket = (path: string, query?: Query): WebSocket => new WebSocket(socketUrl(path, query));
