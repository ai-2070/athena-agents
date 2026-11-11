# Backups: no size limits, with the chats' files

5 November 2026. Build on a new branch from `main` (`LZL0/backups`). It's separate from
[Teach by showing](TEACH_BY_DEMONSTRATION_2026-11-05.md), but should land before that plan's step 2, so the screen
recordings it keeps are backed up from the first day.

## What we want

- **No size limits.** A backup holds the whole project, however big: every chat, every knowledge file, the world, the
  skills, the earlier versions. Nothing is left out because a limit was reached.
- **The chats' files go in by default:**
  - every file attached in an agent chat, a team chat or the Brain chat, screen recordings included;
  - the pictures that tool calls showed in those chats.

  A switch in Settings, **Back up files attached in chats**, is on unless you turn it off.

A restored backup or a clone then shows the chats as they were: attachments open, and pictures show.

## What it does today (`server/backup.ts` on `main`)

- **One file:** a backup is two header lines (the format and a summary, read by the backups list), then one gzipped
  JSON text with every file inside it as base64.
- **The JSON's own limit.** That text can unpack to at most 512 MB (`UNPACKED_MAX`, "about the largest string JSON can
  read"). Base64 makes files a third bigger, so the files share well under that.
- **Limits for each kind** (`CAP`):

  | Kind                     | Limit  |
  | ------------------------ | ------ |
  | Chats                    | 200 MB |
  | Voxel world              | 300 MB |
  | Prefab library           | 100 MB |
  | Team pictures and models | 100 MB |
  | Knowledge files          | 50 MB  |
  | Skills                   | 50 MB  |
  | Earlier versions         | 50 MB  |
  | MEMORY.md files          | 20 MB  |
  | PROJECT.md and notes     | 20 MB  |

  Files past a limit are counted in `omitted`. The Backups window lists the limits when that count isn't zero
  (`web/backup.tsx`).

- **Attachments.** Chats go in (up to their limit), but the files attached in them don't. Only Tasks board files do,
  with whatever room is left (`taskFiles`). Tool pictures (`tool-images/<agent>/<chat>/` in the project's data) don't
  go in either.
- **Upload limit.** A backup dropped in to restore is refused over 512 MB (`FILE_LIMIT` in `server/index.ts`).
- **All in memory.** Making, checking and restoring a backup hold the whole thing in memory
  (`readFileSync`, `gunzipSync`, `JSON.parse`), which is why restores run one at a time.

The JSON text is a hard ceiling, so removing the limits means changing the file's layout, not raising numbers.

## The new layout (format 2)

The two header lines stay as they are, so the backups list still reads the summary without opening the rest. After
them comes a series of **parts**. Each part is one line saying what it is, followed by its bytes:

```
MY-DASHBOARD-BACKUP 2
{ …the summary, as now… }
{"part":"project","enc":"gzip","size":18342,"sha256":"…"}
<bytes>
{"part":"chat","agent":"a1b2","enc":"gzip","size":90211,"sha256":"…"}
<bytes>
{"part":"file","area":"uploads","path":"20261112-1430/screen-recording-2026-11-12-1430.webm","enc":"raw","size":84210933,"sha256":"…"}
<bytes>
…
{"part":"end","parts":412}
```

- **The parts.**
  - `project` is everything that isn't a chat or a file: agents, teams, routines, layout, the board, presets and so
    on, as the JSON holds them now. It also holds the old project's folders, for moving paths on restore.
  - Each chat, team chat and the Brain chat is its own part.
  - Every file is its own part, in an `area`: `knowledge`, `memory`, `brain`, `skill/<slug>`, `versions`, `world`,
    `marks`, `library`, `uploads`, `tool-images`, `logo` and `background`.
- **Compression per part.** Text parts are gzipped. Files that are compressed already (video, pictures, archives)
  are stored as they are, so a recording isn't squeezed for nothing.
- **Streamed.** Writing and reading go one part at a time with streams, so memory use doesn't grow with the backup.
  Only a JSON part is parsed whole, one at a time.
- **Checked.** Each part's sha256 catches damage. The `end` part, with its count, catches a file cut short. `size`
  lets a reader skip a part without reading it.
- **No new dependency**: `node:fs` streams, `node:zlib` and `node:crypto`. It runs under Node for the tests and
  bundles with `Bun.build` for the desktop app.

Why not zip? Users could open it with any unzip tool, which is a plus. But it needs a new dependency, and zip64
support to hold files over 4 GB, and it gives up the readable header lines the backups list uses.

## What changes

### Making a backup

- **No limits.** Every `CAP` and `UNPACKED_MAX` go. `omitted` stays only for files that couldn't be read (a link,
  which is skipped as now, or a file that's locked or missing), and the Backups window names them.
- **Uploads.** The project's whole uploads folder goes in (`area: "uploads"`, paths relative to it), with the switch
  on. That covers chat attachments, the board's files, team-builder drops and screen recordings. With the switch off,
  only the board's files go in, as now.
- **Tool pictures.** The project's `tool-images/` folder goes in, always: the chats show those pictures.
- **Async, with progress.** `createBackup` becomes async, writes to `<name>.tmp` and renames it at the end (as now).
  It reports progress (`emit('backup', { project, done, total })`), which the Back up toast shows as "Backing up… 1.2
  of 3.4 GB".
- **Disk space.** It checks first: it adds up the sizes and compares them with the free space (`fs.statfs`, where
  available). Not enough means a clear message before anything is written.

### Checking it and deleting a project

`verifyBackup` reads the new file through, part by part: each sha256, and the `end` part's count. Only then does
**Delete project** delete anything, as now. A big project takes longer to delete; the toast shows the progress.

### Restoring and cloning

- **Streamed.** `restoreBackup` reads from the file instead of a buffer. The `project` part comes first; it creates
  the project and decides the skill and preset matches as now, comparing skills by the hashes listed in that part.
  Then each part goes to its place as it's read.
- **Files** use `writePacked`'s checks: a part's path must stay inside its area, never through a link, and never
  over a file that's already there.
- **Paths are moved.** Chats hold attachments as full paths, and tool pictures as `/api/file?path=<full path>` links.
  Restore moves both from the old project's folders to the new one's, with the existing `rebase()` (which compares
  resolved paths, so it handles Windows' case and separators):
  - every `attachments` list in agent chats, team chats, the Brain chat and their queued messages;
  - every tool picture link in those chats.

  Board task files are relative already.

- **Upload limit.** `FILE_LIMIT` goes: a dropped backup streams to disk as now, with the free-space check in its place.
- **Clone** writes a temporary backup in the data folder and restores from it, then deletes it. It no longer holds a
  project in memory.
- **Old backups (format 1)** still restore. The reader exists; it turns the old JSON into the same parts in memory.

### Settings and the page

- `Settings` gains `backups: { attachments: boolean }` (default true), shown in Settings as **Back up files attached
  in chats**.
- `web/backup.tsx` drops the limits sentence. Its count of files left out says which files and why.

### What still stays out

- Stored keys and account tokens, never.
- Eve's private runtime files.
- Agents' workspaces and outputs, and the project's own working folder.

The guide still says to back those up separately.

## Tests (`tests/server/backup.test.ts`, `backup-versions.test.ts`)

- **No limits.** A file bigger than its old limit goes in and comes back: a 25 MB file in `notes/`, over the old
  20 MB.
- **Attachments.**
  - Files attached in an agent chat, a team chat, the Brain chat and a queued message come back into the new
    project's uploads.
  - The chats' paths point at them, and tool picture links open the copied pictures.
  - With the switch off, only the board's files go in.
- **Damage.**
  - A backup cut short fails the check, and Delete project deletes nothing.
  - A flipped byte fails with the part named.
- **Unsafe parts.** A path with `..`, an absolute path, or one through a link is refused, and the rest restores.
  A link inside uploads is skipped when backing up.
- **Old backups.** Format 1 backups restore as before (the existing tests keep running against a saved format 1
  file).
- **Clone** copies attachments and tool pictures, and leaves no temporary file behind.
- **The server** (`api.test.ts`): Back up, restore by upload and restore by name still work end to end.

## Docs

- `docs/guide.md` (Back up a project, Restore a backup):
  - drop the size-limits paragraph;
  - say attachments (with the switch) and tool pictures go in;
  - keep "not a full copy of your working folder" for workspaces, outputs and source folders.
- `README.md`: the same, where it describes backups.

## Building it, in order

1. The part writer and reader, with their tests. Make the header lines `2`, and keep the format 1 reader.
2. Make a backup with them: the limits removed, plus uploads, tool pictures, progress and the space check.
3. Restore and clone, with path moving.
4. `verifyBackup`, the delete flow, and the upload limit removed.
5. The setting, the Backups window text, and the docs.
6. `bun run check`, then a hand run: back up a project holding a few hundred MB of recordings, restore it, clone it,
   and delete it.

## Open question

1. **Agents' workspaces and outputs** (renders, models, exports) still stay out, as they can be far bigger than
   everything else. Should a second switch, off by default, put them in?
