// Package Node separately from Bun: Eve's supported server runtime is Node 24.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { shasumFor } from './desktop-target.ts';
import type { DesktopTarget } from './desktop-target.ts';

export const NODE_VERSION = '24.19.0';

/** Read one regular file from a verified tar archive without extracting other paths. */
export function tarFile(tar: Buffer, wanted: string): Buffer {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const prefix = header.subarray(345, 500).toString().split('\0')[0];
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid Node archive size.');
    if ((prefix ? `${prefix}/${name}` : name) === wanted) {
      if (![0, 48].includes(header[156] ?? -1)) throw new Error('The Node executable is not a regular file.');
      return tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('The Node executable is missing from its archive.');
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Node download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

export async function stageNode(target: DesktopTarget, cache: string, output: string): Promise<void> {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const stem = `node-v${NODE_VERSION}-${target.os}-${target.cpu}`;
  const asset = target.os === 'win32' ? `win-${target.cpu}/node.exe` : `${stem}.tar.gz`;
  const cached = path.join(cache, `node-${NODE_VERSION}-${target.os}-${target.cpu}${target.exe}`);
  // Revalidate a cached executable, not only a newly downloaded archive.
  const expectedFile = cached + '.sha256';
  const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const cachedBytes = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  const valid = cachedBytes && fs.existsSync(expectedFile) && digest(cachedBytes) === fs.readFileSync(expectedFile, 'utf8');
  if (!valid) {
    const [bytes, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHASUMS256.txt`)]);
    if (digest(bytes) !== shasumFor(sums.toString('utf8'), asset)) throw new Error('Node download checksum mismatch.');
    const executable = target.os === 'win32' ? bytes : tarFile(zlib.gunzipSync(bytes), `${stem}/bin/node`);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(cached, executable);
    fs.writeFileSync(expectedFile, digest(executable));
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(cached, output);
  if (!target.exe) fs.chmodSync(output, 0o755);
  const license = path.join(path.dirname(output), 'NODE_LICENSE');
  fs.writeFileSync(license, await download(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`));
}
