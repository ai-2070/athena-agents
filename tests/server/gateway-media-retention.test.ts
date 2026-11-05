import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayUploadReservation } from '../../shared/types.ts';
import { activeProject, listProjects, saveProjects, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import { newBatch, receiveSource, reserveName, uploadsRoot } from '../../server/uploads.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayRetirement } from '../../server/gateways/retirement.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { claimGatewayAccount, claimGatewayState } from '../../server/gateways/ownership.ts';
import * as ownership from '../../server/gateways/ownership.ts';
import { GATEWAY_MEDIA_RETENTION_MS, recordGatewayUploadReservation } from '../../server/gateways/media-retention.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 197000;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const project = activeProject(); const instance = saveGatewayInstance({ ...gatewayConfig(String(account++)), projectId: project.id });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state); const input = inbox.accept({ ...gatewayInput(), accountId: instance.accountId, media: [{ kind: 'file', fileId: 'one', name: 'one.txt', size: 5 }] })!;
  const event = inbox.prepareFiles(input.id, () => newBatch().batch); const attempt = inbox.beginTransfer(event.id, 0);
  const dir = path.join(uploadsRoot(), event.fileBatch!); const proofDir = dataPath('gateways-runtime', instance.id, 'upload-reservations');
  const inboxFile = state.inboxFile();
  closes.push(async () => { fs.rmSync(proofDir, { recursive: true, force: true }); });
  const value = new GatewaySupervisor(() => { throw new Error('Must not open a transport'); }); closes.push(() => value.stop());
  const allocate = (name = '1-one.txt', rename = false) => {
    const target = reserveName(path.join(dir, name)); const temporary = `${target}.${crypto.randomBytes(3).toString('hex')}.part`;
    fs.closeSync(fs.openSync(temporary, 'wx')); const before = new Set(fs.existsSync(proofDir) ? fs.readdirSync(proofDir) : []);
    withProject(project, () => recordGatewayUploadReservation(event, target, temporary));
    const proof = path.join(proofDir, fs.readdirSync(proofDir).find((name) => !before.has(name))!);
    fs.writeFileSync(temporary, 'hello'); if (rename) fs.renameSync(temporary, target);
    return { target, temporary, proof };
  };
  const retire = async () => { await state.disconnect(); await value.removeInstance(instance.id); };
  const age = () => { const now = gatewayRetirement(instance.id)!.completedAt! + GATEWAY_MEDIA_RETENTION_MS + 1000; vi.spyOn(Date, 'now').mockReturnValue(now); };
  return { instance, project, state, inbox, inboxFile, event, attempt, dir, proofDir, value, allocate, retire, age };
}

it('retains scratch for 24 hours after completed removal, then removes only proven leftovers', async () => {
  const f = await fixture(); const partial = f.allocate(); const saved = f.allocate('2-saved.txt', true);
  f.inbox.finishTransfer(f.event.id, 0, f.attempt.id, { path: saved.target, top: saved.target, name: '2-saved.txt', kind: 'file', size: 5 }, crypto.createHash('sha256').update('hello').digest('hex'));
  f.inbox.failFile(f.event.id, 0, 'changed');
  fs.writeFileSync(path.join(f.dir, 'user-notes.txt'), 'Keep this file'); fs.writeFileSync(path.join(f.dir, 'legacy.part'), 'Unproven');
  const native = fs.readFileSync(f.inboxFile, 'utf8'); const sdk = fs.readFileSync(dataPath('gateways-runtime', f.instance.id, 'sdk-state.json'), 'utf8');
  await f.retire(); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 }); expect(fs.existsSync(partial.temporary)).toBe(true);
  f.age(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 2, blocked: 0 }); expect(fs.existsSync(partial.target)).toBe(false); expect(fs.existsSync(partial.temporary)).toBe(false);
  expect(fs.readFileSync(saved.target, 'utf8')).toBe('hello'); expect(fs.readFileSync(path.join(f.dir, 'user-notes.txt'), 'utf8')).toBe('Keep this file'); expect(fs.existsSync(path.join(f.dir, 'legacy.part'))).toBe(true);
  expect(fs.readFileSync(f.inboxFile, 'utf8')).toBe(native); expect(fs.readFileSync(dataPath('gateways-runtime', f.instance.id, 'sdk-state.json'), 'utf8')).toBe(sdk); expect(fetch).not.toHaveBeenCalled();
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 });
});

it('recovers the rename-before-receipt crash in its original project on startup', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age();
  const other = await createProject({ name: 'Other upload project' }); const bytes = fs.readFileSync(f.inboxFile, 'utf8');
  await withProject(other, () => f.value.start()); expect(fs.existsSync(orphan.target)).toBe(false); expect(fs.readFileSync(f.inboxFile, 'utf8')).toBe(bytes);
  await f.value.stop(); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 });
});

it('keeps pending removal, recent edits and legacy unrecorded batches untouched', async () => {
  const f = await fixture(); const partial = f.allocate();
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 }); await f.retire(); f.age();
  fs.utimesSync(partial.temporary, new Date(Date.now()), new Date(Date.now()));
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 }); expect(fs.readFileSync(partial.temporary, 'utf8')).toBe('hello'); expect(fs.existsSync(partial.proof)).toBe(true);
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 });
});

it('keeps a replacement file even if its name and age match a former reservation', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); const replacement = path.join(f.dir, 'replacement.txt'); fs.writeFileSync(replacement, 'User replacement'); fs.renameSync(replacement, orphan.target);
  await f.retire(); f.age();
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 }); expect(fs.readFileSync(orphan.target, 'utf8')).toBe('User replacement');
});

it.each(['file', 'batch', 'root', 'proof'] as const)('does not follow a replaced %s link', async (kind) => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); const other = newBatch(); const victim = path.join(other.dir, 'victim.txt'); fs.writeFileSync(victim, 'Must survive');
  if (kind === 'file') { fs.unlinkSync(orphan.target); fs.symlinkSync(victim, orphan.target); }
  if (kind === 'batch') { fs.renameSync(f.dir, `${f.dir}-held`); fs.symlinkSync(other.dir, f.dir, process.platform === 'win32' ? 'junction' : 'dir'); }
  if (kind === 'root') { const root = uploadsRoot(); fs.renameSync(root, `${root}-held`); fs.symlinkSync(`${root}-held`, root, process.platform === 'win32' ? 'junction' : 'dir'); closes.push(async () => { fs.unlinkSync(root); fs.renameSync(`${root}-held`, root); }); }
  if (kind === 'proof') { fs.renameSync(orphan.proof, `${orphan.proof}-held`); fs.symlinkSync(`${orphan.proof}-held`, orphan.proof); }
  await f.retire(); f.age(); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: kind === 'proof' ? 1 : 0 }); expect(fs.readFileSync(victim, 'utf8')).toBe('Must survive');
});

it.each(['account', 'state'] as const)('retries cleanup when %s ownership becomes available', async (kind) => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age();
  const release = await (kind === 'account' ? claimGatewayAccount(f.instance.platform, f.instance.accountId) : claimGatewayState(f.instance.id)); closes.push(release);
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 1 }); expect(fs.existsSync(orphan.target)).toBe(true);
  await release(); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 });
});

it.each(['proof', 'inbox'] as const)('refuses corrupt %s evidence without rewriting it', async (kind) => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age(); const file = kind === 'proof' ? orphan.proof : f.inboxFile; const bytes = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, '{broken');
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 1 }); expect(fs.existsSync(orphan.target)).toBe(true); expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  fs.writeFileSync(file, bytes); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 });
});

it('refuses changed project, batch and source proof while another removed instance can clean up', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); const other = await fixture(); const otherOrphan = other.allocate('1-other.txt', true); await other.retire(); f.age();
  const proof = readJSON<GatewayUploadReservation>(orphan.proof)!; writeJSON(orphan.proof, { ...proof, batch: 'another-batch' });
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 }); expect(fs.existsSync(orphan.target)).toBe(true); expect(fs.existsSync(otherOrphan.target)).toBe(false);
  writeJSON(orphan.proof, { ...proof, projectId: 'other-project' }); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 });
  writeJSON(orphan.proof, { ...proof, eventId: '0'.repeat(64) }); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 });
});

it('keeps bytes when the original project is missing or moved without creating a replacement folder', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age();
  const projects = listProjects(); const brain = `${f.project.brainPath}-moved`;
  try {
    saveProjects(projects.map((project) => project.id === f.project.id ? { ...project, brainPath: brain } : project));
    expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 }); expect(fs.existsSync(brain)).toBe(false);
    saveProjects(projects.filter((project) => project.id !== f.project.id)); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 0 }); expect(fs.readFileSync(orphan.target, 'utf8')).toBe('hello');
  } finally { saveProjects(projects); }
});

it('retries an interrupted unlink without deleting saved state or losing the ownership proof', async () => {
  const f = await fixture(); const partial = f.allocate(); await f.retire(); f.age(); const unlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => { if (String(file) === partial.temporary) throw new Error('PRIVATE_PATH'); return unlink(file); });
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 1 }); expect(fs.existsSync(partial.target)).toBe(false); expect(fs.existsSync(partial.temporary)).toBe(true); expect(fs.existsSync(partial.proof)).toBe(true);
  vi.restoreAllMocks(); f.age(); expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 });
});

it('refuses a removal record changed while acquiring ownership', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age();
  const file = dataPath('gateways-retired', `${f.instance.id}.json`); const record = gatewayRetirement(f.instance.id)!;
  const claim = ownership.claimGatewayState;
  vi.spyOn(ownership, 'claimGatewayState').mockImplementation(async (id) => { const release = await claim(id); if (id === f.instance.id) writeJSON(file, { ...record, name: 'Changed record' }); return release; });
  expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 0, blocked: 1 }); expect(fs.existsSync(orphan.target)).toBe(true);
});

it('cleans without opening broken SDK or credential storage', async () => {
  const f = await fixture(); const orphan = f.allocate('1-orphan.txt', true); await f.retire(); f.age();
  const sdk = dataPath('gateways-runtime', f.instance.id, 'sdk-state.json'); fs.writeFileSync(sdk, 'Broken SDK bytes');
  const secrets = dataPath('gateway-secrets.json'); const before = fs.readFileSync(secrets, 'utf8'); fs.writeFileSync(secrets, '{broken credentials');
  try { expect(await f.value.cleanRetiredMedia()).toEqual({ removed: 1, blocked: 0 }); expect(fs.existsSync(orphan.target)).toBe(false); expect(fs.readFileSync(sdk, 'utf8')).toBe('Broken SDK bytes'); expect(fs.readFileSync(secrets, 'utf8')).toBe('{broken credentials'); }
  finally { fs.writeFileSync(secrets, before); }
});

it('sweeps on startup and hourly, and cancels the timer on shutdown', async () => {
  const value = new GatewaySupervisor(() => { throw new Error('No transport'); }); closes.push(() => value.stop());
  const sweep = vi.spyOn(value, 'cleanRetiredMedia').mockResolvedValue({ removed: 0, blocked: 0 });
  vi.useFakeTimers();
  try {
    await value.start(); expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); expect(sweep).toHaveBeenCalledTimes(2);
    await value.stop(); await vi.advanceTimersByTimeAsync(60 * 60 * 1000); expect(sweep).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('cannot stream a byte when the private ownership proof fails to save', async () => {
  const f = await fixture(); const write = fs.writeFileSync.bind(fs); let produced = false;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('upload-reservations')) throw new Error('PRIVATE_PATH'); return write(file, ...args); });
  await expect(receiveSource((async function* () { produced = true; yield Buffer.from('hello'); })(), f.event.fileBatch!, '1-one.txt', { reserved: (target, temporary) => { recordGatewayUploadReservation(f.event, target, temporary); } })).rejects.toThrow();
  expect(produced).toBe(false); expect(fs.readdirSync(f.dir)).toEqual([]);
});

it('records both file identities before consuming a shared upload stream', async () => {
  const batch = newBatch(); let proof = false;
  const saved = await receiveSource(Readable.from([Buffer.from('hello')]), batch.batch, 'browser.txt', { reserved: (target, temporary) => { expect(fs.statSync(target).size).toBe(0); expect(fs.statSync(temporary).size).toBe(0); proof = true; } });
  expect(proof).toBe(true); expect(fs.readFileSync(saved.path, 'utf8')).toBe('hello');
});
