// Reads one PDF's text, in a thread of its own (server/documents.ts starts it). pdf.js parses on the
// thread that calls it and a hostile file can keep it busy for minutes; a thread can be stopped.
// Runs as a file of its own (plain Node or Bun, types stripped), so it imports nothing of the app's.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

interface Job {
  bytes: Uint8Array;
  maxPages: number;
}
type Answer = { text: string; total: number; read: number } | { error: 'password' | 'unreadable' };

async function read({ bytes, maxPages }: Job): Promise<Answer> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // text only: no fonts or images loaded or drawn; and no warnings about broken files in the server's log
    pdf = await getDocumentProxy(bytes, { disableFontFace: true, stopAtErrors: false, verbosity: 0 });
  } catch (error) {
    return { error: error instanceof Error && error.name === 'PasswordException' ? 'password' : 'unreadable' };
  }
  try {
    const total = pdf.numPages;
    const count = Math.min(total, maxPages);
    const pages: string[] = [];
    for (let number = 1; number <= count; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(`--- Page ${number} ---\n${lines.join('\n').trim()}`);
      page.cleanup();
    }
    return { text: pages.join('\n\n'), total, read: count };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

read(workerData as Job).then(
  (answer) => parentPort?.postMessage(answer),
  () => parentPort?.postMessage({ error: 'unreadable' } satisfies Answer),
);
