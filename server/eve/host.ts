import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DATA, IS_WIN, ensureDir, isInside, realTarget } from '../util.ts';
import type { ChildProcess } from 'node:child_process';

export interface EveHostOptions {
  executable: string;
  entry: string;
  templates: string;
  directory: string;
  bridgeUrl: string;
  bridgeToken: string;
}

export interface EveHost {
  url: string;
  token: string;
  close(): Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
const owners = new Set<string>();

function noLinks(directory: string) {
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink() || fs.readdirSync(directory, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink())) throw new Error('Eve filesystem templates cannot contain links.');
}

/** The owner must close this handle; stdin also closes automatically if the owner crashes. */
export async function startEveHost(options: EveHostOptions): Promise<EveHost> {
  const resolved = path.resolve(options.directory);
  const key = IS_WIN ? resolved.toLowerCase() : resolved;
  if (owners.has(key)) throw new Error('This Eve runtime folder already has an owner.');
  owners.add(key);
  try {
    const host = await launchEveHost(options);
    return { ...host, close: async () => { try { await host.close(); } finally { owners.delete(key); } } };
  } catch (error) {
    owners.delete(key);
    throw error;
  }
}

async function launchEveHost(options: EveHostOptions): Promise<EveHost> {
  const dataRoot = realTarget(DATA);
  const wanted = realTarget(options.directory);
  if (!dataRoot || !wanted || !isInside(dataRoot, wanted)) throw new Error('Eve runtime state must stay under the data folder.');
  const directory = ensureDir(options.directory);
  const templates = path.join(directory, '.eve', 'sandbox-cache');
  const templateTarget = realTarget(templates);
  if (!templateTarget || !isInside(wanted, templateTarget)) throw new Error('The Eve filesystem cache points outside its runtime folder.');
  noLinks(options.templates);
  noLinks(templates);
  fs.cpSync(options.templates, templates, { recursive: true, force: false, errorOnExist: false });
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not choose a private Eve port.');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const token = crypto.randomBytes(32).toString('hex');
  const child: ChildProcess = spawn(options.executable, [options.entry], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: String(port), NITRO_PORT: String(port), WORKFLOW_LOCAL_BASE_URL: url, ATHENA_EVE_TOKEN: token, ATHENA_EVE_BRIDGE_URL: options.bridgeUrl, ATHENA_EVE_BRIDGE_TOKEN: options.bridgeToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Runtime output can contain model/provider diagnostics; do not broadcast or log raw output.
  child.stdout?.resume();
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  let failure: Error | undefined;
  child.on('error', (error) => { failure = error; });
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null || failure) return;
    const exited = once(child, 'exit');
    child.stdin?.end();
    if (await Promise.race([exited.then(() => true), pause(3000).then(() => false)])) return;
    child.kill();
    if (await Promise.race([exited.then(() => true), pause(3000).then(() => false)])) return;
    child.kill('SIGKILL');
    await exited;
  }
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('The Eve runtime exited before it was ready.');
      try {
        const response = await fetch(`${url}/eve/v1/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        const result: unknown = response.ok ? await response.json() : null;
        if (result && typeof result === 'object' && 'ok' in result && result.ok === true && 'status' in result && result.status === 'ready') return { url, token, close };
      } catch { /* the private listener is still starting */ }
      await pause(100);
    }
    throw new Error('The Eve runtime did not become ready.');
  } catch (error) {
    await close();
    throw error;
  }
}
