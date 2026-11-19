// The Outbox: questions agents asked you, and posts, comments, DMs and chat app messages they drafted, waiting for
// you to answer, or to approve, edit, discuss or reject. A Telegram, Slack or Discord message goes to a chat you
// choose, one the project's gateways have talked in.
// A page of its own (the left menu) and a tab in Settings > Connections.
import { Plate } from '../ui/surface.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { attempt, toast, ago, refreshSoon } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { fetchFile } from '../client/http.ts';
import { fileUrl } from '../client/connection.ts';
import { openFile } from '../filepreview.tsx';
import { Icon, reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { SelectControl } from '../ui/select.tsx';
import { Section, Sections } from '../ui/controls.tsx';
import { Pill } from '../ui/marks.tsx';
import type { PillTone } from '../ui/marks.tsx';
import { QuestionCard } from '../questions.tsx';
import { xLength, X_MAX_LENGTH } from '../../shared/xtext.ts';
import type { AgentQuestion, OutboxPost } from '../../shared/types.ts';
import type { GatewayChatChoice } from '../../shared/api/outbox.ts';

/** X's limit for one post. */
const LIMIT = X_MAX_LENGTH;
/** Characters as X counts them (an emoji or a Chinese letter is two, a link 23). */
export const chars = (text: string): number => xLength(text);

/** Puts an image on the clipboard (as a PNG, which is what pasting into a post accepts). */
async function copyImage(url: string): Promise<void> {
  try {
    let blob = await (await fetchFile(url)).blob();
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((ok, no) =>
        canvas.toBlob((b) => (b ? ok(b) : no(new Error('no image'))), 'image/png'),
      );
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied');
  } catch {
    toast("Couldn't copy the image here. Use Save instead.", 'error');
  }
}

export function Outbox() {
  const data = useAppState();
  const [list, setList] = useState<OutboxPost[] | null>(null);
  const [chats, setChats] = useState<GatewayChatChoice[]>([]);
  const version = useRef(0);
  const reload = useCallback(async () => {
    const next = ++version.current;
    const [value, known] = await Promise.all([rpc.outbox.list(), rpc.outbox.chats().catch(() => [])]);
    if (next !== version.current) return;
    setList(value);
    setChats(known);
  }, []);
  useEffect(() => void reload().catch(() => setList([])), [reload]);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  useServerEvents((ev) => {
    if (ev.type === 'project') setList(null);
    if (['outbox', 'project', 'chat-gateways', 'gateway-messages'].includes(ev.type)) void reload().catch(() => {});
  });
  if (!list || !data) return null;
  const pending = list.filter((p) => ['pending', 'failed', 'posting'].includes(p.status));
  const done = list.filter((p) => p.status === 'posted' || p.status === 'rejected' || p.status === 'returned');
  const changed = () => (void reload(), refreshSoon(0));
  return (
    <Sections>
      <Questions />
      {data.accounts.x.length ? (
        <Compose accounts={data.accounts.x.map((a) => a.username)} added={() => void reload()} />
      ) : null}
      {/* nothing waiting: the heading goes above, so the note is in the middle of the page, not of the right column */}
      <Section
        title={`Waiting for you (${pending.length})`}
        headingClassName="section"
        bare
        className={pending.length ? '' : 'lg:grid-cols-1'}
      >
        {pending.length ? (
          <div className="flex flex-col gap-4">
            {pending.map((p) => (
              <PostCard key={p.id} p={p} chats={chats} changed={changed} />
            ))}
          </div>
        ) : (
          <div className="empty mx-auto max-w-[56ch] py-12">
            No posts waiting. Agents with the Social tools put their drafts here.
          </div>
        )}
      </Section>
      {done.length ? (
        <Section title="History" headingClassName="section" bare>
          <div className="flex flex-col gap-4">
            {done.slice(0, 40).map((p) => (
              <PostCard key={p.id} p={p} chats={chats} changed={changed} />
            ))}
          </div>
        </Section>
      ) : null}
    </Sections>
  );
}

/** What agents asked you (ask_user): the waiting ones first, then the last ones you answered. */
function Questions() {
  const [list, setList] = useState<AgentQuestion[] | null>(null);
  const reload = useCallback(() => rpc.questions.list().then(setList), []);
  useEffect(() => void reload().catch(() => setList([])), [reload]);
  useServerEvents((ev) => (ev.type === 'questions' || ev.type === 'project') && void reload().catch(() => {}));
  if (!list?.length) return null;
  const waiting = list.filter((q) => q.status === 'waiting').reverse();
  const done = list.filter((q) => q.status !== 'waiting').slice(0, 20);
  const changed = () => void reload().catch(() => {});
  return (
    <Section title={`Questions from agents (${waiting.length})`} headingClassName="section" bare>
      {waiting.length ? (
        <div className="flex flex-col gap-4">
          {waiting.map((q) => (
            <QuestionCard key={q.id} q={q} changed={changed} />
          ))}
        </div>
      ) : (
        <div className="empty mx-auto max-w-[56ch] py-12">
          No questions waiting. When an agent needs you to choose or is stuck, it asks here.
        </div>
      )}
      {done.length ? (
        <details className="mt-4">
          <summary className="hint">{`Answered and closed (${done.length})`}</summary>
          <div className="mt-4 flex flex-col gap-4">
            {done.map((q) => (
              <QuestionCard key={q.id} q={q} changed={changed} />
            ))}
          </div>
        </details>
      ) : null}
    </Section>
  );
}

function Compose({ accounts, added }: { accounts: string[]; added: () => void }) {
  const [text, setText] = useState('');
  const [account, setAccount] = useState(accounts[0]);
  const save = async () => {
    if (await attempt(() => rpc.outbox.draft({ platform: 'x', account, text }), 'Added to the Outbox')) {
      setText('');
      added();
    }
  };
  return (
    <Section title="New post" bare>
      <Plate className="panel">
        <textarea
          rows={3}
          aria-label="New post"
          placeholder="Write a post yourself…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SelectControl
            aria-label="Post as"
            value={account}
            onChange={setAccount}
            options={accounts.map((a) => ({ value: a, label: `@${a}` }))}
          />
          <span className="hint flex-1 min-w-0" />
          <Button variant="ghost" size="small" onClick={() => void save()}>
            <Icon name="save" size={13} />
            Save to Outbox
          </Button>
        </div>
      </Plate>
    </Section>
  );
}

const STATUS: Record<string, [PillTone, string]> = {
  pending: ['warn', 'Waiting'],
  failed: ['bad', 'Failed'],
  posting: ['info', 'Posting…'],
  posted: ['ok', 'Posted'],
  rejected: ['dim', 'Rejected'],
  returned: ['info', 'Sent back'],
};

const GATEWAY_PLATFORMS = ['telegram', 'slack', 'discord'];
const chatValue = (g: { instanceId: string; chatKey: string } | undefined) => (g ? `${g.instanceId} ${g.chatKey}` : '');

function PostCard({ p, chats, changed }: { p: OutboxPost; chats: GatewayChatChoice[]; changed: () => void }) {
  // the desktop app opens an image in its own program
  const desktop = !!useAppState()?.desktop;
  const editable = p.status === 'pending' || p.status === 'failed';
  const serverTitle = p.platform === 'reddit' && p.reddit?.kind === 'post' ? p.reddit.title || '' : null;
  const [parts, setPartsNow] = useState(p.parts);
  // images that go with the first part; an ✕ on a thumbnail takes it off before approving
  const [images, setImagesNow] = useState(p.images || []);
  const [title, setTitleNow] = useState(serverTitle);
  // changed here and not saved yet: until then, a newer version from the server (saved in another
  // tab, a thread partly posted) replaces what the card shows, so Approve never sends an old copy
  const edited = useRef(false);
  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      edited.current = true;
      set(v);
    };
  const setParts = touch(setPartsNow);
  const setImages = touch(setImagesNow);
  const setTitle = touch(setTitleNow);
  const fromServer = JSON.stringify([p.parts, p.images || [], serverTitle]);
  useEffect(() => {
    if (edited.current) return;
    setPartsNow(p.parts);
    setImagesNow(p.images || []);
    setTitleNow(serverTitle);
    // (fromServer stands for all three)
  }, [fromServer]);
  const [discussing, setDiscussing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Telegram, Slack, Discord: the chat it goes to (fixed once part of it went out)
  const gateway = GATEWAY_PLATFORMS.includes(p.platform);
  const options = chats
    .filter((c) => c.platform === p.platform)
    .map((c) => ({ value: chatValue(c), label: `${c.title} · ${c.instanceName}` }));
  const [chat, setChat] = useState(chatValue(p.gateway));
  const picked = chats.find((c) => chatValue(c) === chat);
  const edits = () => ({
    parts,
    ...(p.images ? { images } : {}),
    ...(title !== null ? { title } : {}),
    ...(picked && !p.sentParts ? { gateway: { instanceId: picked.instanceId, chatKey: picked.chatKey } } : {}),
  });

  const approve = async () => {
    setBusy(true);
    const r = await attempt(() => rpc.outbox.approve({ id: p.id, ...edits() }));
    if (r?.status === 'posted') toast('Posted ✓');
    else if (r?.status === 'failed') toast(r.error as string, 'error', 8000);
    setBusy(false);
    changed();
  };
  const discuss = async () => {
    setBusy(true);
    const r = await attempt(
      () => rpc.outbox.discuss({ id: p.id, text: note }),
      `Sent back to ${p.teamName || 'the team'}`,
    );
    setBusy(false);
    if (r) changed();
  };
  const [tone, label]: [PillTone, string] = STATUS[p.status] || ['dim', p.status];
  const link = p.platform === 'reddit' ? 'View on Reddit' : p.platform === 'x_dm' ? 'Open messages' : 'View on X';
  return (
    <Plate className="panel">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone={tone}>{label}</Pill>
        <b>{p.accountLabel}</b>
        <span className="hint">{`by ${p.agentName || 'you'}${p.teamName ? ` · team ${p.teamName}` : ''} · ${ago(p.createdAt)}`}</span>
        {p.parts.length > 1 ? <Pill tone="info">{`thread of ${p.parts.length}`}</Pill> : null}
        {p.url ? (
          <ButtonLink variant="ghost" size="tiny" className="ml-auto" href={p.url} target="_blank" rel="noopener">
            <Icon name="external-link" size={12} />
            {link}
          </ButtonLink>
        ) : null}
      </div>
      {p.platform === 'reddit' ? (
        <div className="hint mt-4">
          {p.reddit?.kind === 'comment'
            ? `Comment replying to ${p.reddit.parent}`
            : `Post in r/${p.reddit?.subreddit}${p.reddit?.link ? ` · link: ${p.reddit.link}` : ''}`}
        </div>
      ) : null}
      {title !== null ? (
        <div className="mt-4">
          <input
            aria-label="Title"
            placeholder="Title"
            value={title}
            disabled={!editable}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      ) : null}
      {gateway && editable && !p.sentParts ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="hint">Send to</span>
          {options.length ? (
            <SelectControl
              aria-label="Send to"
              value={chat}
              onChange={setChat}
              options={[...(chat ? [] : [{ value: '', label: 'Choose a chat' }]), ...options]}
            />
          ) : (
            <span className="hint">
              No {p.platform === 'telegram' ? 'Telegram' : p.platform === 'slack' ? 'Slack' : 'Discord'} chats yet: a
              gateway can send only where someone has talked to it. <a href="#/settings?tab=gateways">Gateways</a>
            </span>
          )}
        </div>
      ) : null}
      {p.note ? <p className="hint mt-4">{p.note}</p> : null}
      {p.error ? <p className="text-red mt-4">{p.error as string}</p> : null}
      {p.status === 'returned' && p.reason ? <p className="hint mt-4">{`Sent back to the team: ${p.reason}`}</p> : null}
      {images.length ? (
        <div className="flex flex-wrap items-start gap-3 mt-4">
          {images.map((f) => {
            const url = fileUrl(f);
            const name = f.split(/[\\/]/).pop() || 'image';
            return (
              <div key={f} className="flex flex-col gap-1.5">
                <div className="relative">
                  <img
                    className="max-h-30 max-w-45 rounded-[8px] block"
                    src={url}
                    alt={p.imageAlt?.[f] || name}
                    title={p.imageAlt?.[f] || f}
                  />
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="tiny"
                      className="absolute top-1 right-1"
                      title="Take this image off the post"
                      aria-label={`Take ${name} off the post`}
                      onClick={() => setImages(images.filter((x) => x !== f))}
                    >
                      ✕
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="tiny"
                    title="Copy the image, to paste it into a post yourself"
                    onClick={() => void copyImage(url)}
                  >
                    <Icon name="copy" size={12} />
                    Copy
                  </Button>
                  <ButtonLink variant="ghost" size="tiny" href={url} download={name} title="Save the image file">
                    <Icon name="download" size={12} />
                    Save
                  </ButtonLink>
                  {desktop ? (
                    <Button variant="ghost" size="tiny" title={`Open ${name}`} onClick={() => openFile(f)}>
                      <Icon name="external-link" size={12} />
                      Open
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {editable ? (
        <div className="flex flex-col gap-3 mt-4">
          {parts.map((t, i) => (
            <div key={i}>
              <textarea
                aria-label={parts.length > 1 ? `Part ${i + 1}` : 'Text'}
                rows={Math.min(6, Math.ceil(t.length / 70) + 1)}
                value={t}
                onChange={(e) => setParts(parts.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <div className="flex flex-wrap items-center gap-3 justify-between">
                <span className="hint">{parts.length > 1 ? `Part ${i + 1}` : ''}</span>
                {p.platform === 'x' ? (
                  <span
                    className={`hint tabular-nums ${chars(t) > LIMIT ? 'text-red' : ''}`}
                  >{`${chars(t)}/${LIMIT}`}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {p.parts.map((t, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {t}
            </div>
          ))}
        </div>
      )}
      {editable ? (
        <>
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Button size="small" disabled={busy || (gateway && !picked && !p.gateway)} onClick={() => void approve()}>
              <Icon name="check" size={13} />
              {p.platform === 'x' ? 'Approve & post' : 'Approve & send'}
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={() =>
                void attempt(() => rpc.outbox.edit({ id: p.id, ...edits() }), 'Saved').then(
                  (r) => r && (edited.current = false),
                )
              }
            >
              <Icon name="save" size={13} />
              Save edits
            </Button>
            <Button
              variant="ghost"
              size="small"
              aria-expanded={discussing}
              title="Talk it over with the team that wrote it: your note goes into their chat and the draft is sent back"
              onClick={() => setDiscussing(!discussing)}
            >
              <Icon name="message-circle" size={13} />
              Discuss with team
            </Button>
            <Button
              variant="danger"
              size="small"
              onClick={() => void attempt(() => rpc.outbox.reject({ id: p.id })).then(changed)}
            >
              <Icon name="x" size={13} />
              Reject
            </Button>
          </div>
          {/* what should change: goes to the team's chat as a message to the agent who wrote it, and the draft leaves the Outbox */}
          {discussing ? (
            <div className="flex flex-col gap-3 mt-4">
              <textarea
                rows={3}
                aria-label="What should change"
                placeholder={`What should change? This goes to ${p.agentName || 'the team'}${p.teamName ? ` in the ${p.teamName} chat` : ''}.`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button size="small" disabled={busy} onClick={() => void discuss()}>
                  <Icon name="send" size={13} />
                  Send to team
                </Button>
                <Button variant="ghost" size="small" onClick={() => setDiscussing(false)}>
                  <Icon name="x" size={13} />
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <Button
            variant="ghost"
            size="tiny"
            onClick={() => void attempt(() => rpc.outbox.remove({ id: p.id })).then(changed)}
          >
            <Icon name="trash-2" size={12} />
            Remove
          </Button>
        </div>
      )}
    </Plate>
  );
}

export const title = () => 'Outbox';
export const { render, unmount } = reactPage(() => <Outbox />);
