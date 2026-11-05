import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { dataPath } from '../../server/util.ts';

const exec = promisify(execFile);

describe('pinned Chat SDK transport proof', () => {
  it.each(['bun', process.execPath])('verifies WhatsApp account and private media under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-whatsapp-media-smoke.ts'], { env: process.env, timeout: 20000, windowsHide: true });
    expect(stdout).toContain('WhatsApp SDK account checks, ACK-gated private media, signed hash and bound project pass');
    expect(stdout).toContain('WhatsApp service-window replies and selected document upload pass');
    expect(stdout).toContain('WhatsApp paired transport reconnect, replay dedupe and guarded delivery pass');
    expect(stdout).toContain('WhatsApp one-use pairing saves private keys and pins a paused instance');
    expect(stdout).toContain('WhatsApp saved gap review survives restart and keeps prior work intact');
    expect(stdout).toContain('held request dismissal preserves its receipt without work or delivery');
    expect(stdout).toContain('WhatsApp paused setup checks verify account and relay without intake or writes');
    expect(stdout).toContain('WhatsApp original relay restoration preserves receipts and held work');
    expect(stdout).toContain('WhatsApp replacement saves a new key across restart and quarantines old receipts');
    expect(stdout).toContain('WhatsApp sender review keeps retired aliases and old work held across restart');
    expect(stdout).toContain('paused delivery review confirms only checked parts and finishes locally without sends or model replay');
    expect(stdout).toContain('keeping native work local preserves signed receipts across restart and admits only fresh private work');
  });

  it('runs the bundled WhatsApp media adapter from read-only files outside the checkout', async () => {
    const directory = dataPath('whatsapp-media-bundle'); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'proof.mjs');
    await exec('bun', ['build', 'scripts/gateways-whatsapp-media-smoke.ts', '--target=node', '--outfile', file], { env: process.env, timeout: 20000, windowsHide: true });
    fs.chmodSync(file, 0o444); fs.chmodSync(directory, 0o555);
    try {
      const { stdout } = await exec(process.execPath, [file], { cwd: directory, env: process.env, timeout: 20000, windowsHide: true });
      expect(stdout).toContain('WhatsApp SDK account checks, ACK-gated private media, signed hash and bound project pass');
      expect(stdout).toContain('WhatsApp service-window replies and selected document upload pass');
      expect(stdout).toContain('WhatsApp paired transport reconnect, replay dedupe and guarded delivery pass');
      expect(stdout).toContain('WhatsApp one-use pairing saves private keys and pins a paused instance');
      expect(stdout).toContain('WhatsApp saved gap review survives restart and keeps prior work intact');
      expect(stdout).toContain('held request dismissal preserves its receipt without work or delivery');
      expect(stdout).toContain('WhatsApp paused setup checks verify account and relay without intake or writes');
      expect(stdout).toContain('WhatsApp original relay restoration preserves receipts and held work');
      expect(stdout).toContain('WhatsApp replacement saves a new key across restart and quarantines old receipts');
      expect(stdout).toContain('WhatsApp sender review keeps retired aliases and old work held across restart');
      expect(stdout).toContain('paused delivery review confirms only checked parts and finishes locally without sends or model replay');
      expect(stdout).toContain('keeping native work local preserves signed receipts across restart and admits only fresh private work');
    } finally { fs.chmodSync(directory, 0o755); fs.chmodSync(file, 0o644); }
  });

  it.each(['bun', process.execPath])('proves the hosted WhatsApp relay across Node processes and read-only Worker files under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-whatsapp-relay-smoke.ts'], { env: process.env, timeout: 30000, windowsHide: true });
    expect(stdout).toContain('WhatsApp relay signed intake, process restart, commit-before-ack, replay, lease and revocation pass');
    expect(stdout).toContain('WhatsApp bundled local intake holds work across a lost ACK reply and process restart');
    expect(stdout).toContain('WhatsApp verified identity mappings survive restart and signed rotations hold old work');
    expect(stdout).toContain('WhatsApp authenticated consumer restores its pinned relay and exact ACK across processes');
  });

  it.each(['bun', process.execPath])('verifies Discord Gateway recovery and durable receipts under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-discord-smoke.ts'], { env: process.env, timeout: 20000, windowsHide: true });
    expect(stdout).toContain('Discord verified identities, guild scopes, permissions, source replay and partial edits pass');
    expect(stdout).toContain('Discord Gateway Identify, durable cursor, failed-write replay and Resume pass');
    expect(stdout).toContain('Discord private download, bounded replies and selected document upload pass');
    expect(stdout).toContain('shared Discord transport resumes without a new Identify or repeated delivery');
  });

  it('bundles the Discord Gateway proof and runs it from read-only files outside the checkout', async () => {
    const directory = dataPath('discord-sdk-bundle'); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'proof.mjs');
    await exec('bun', ['build', 'scripts/gateways-discord-smoke.ts', '--target=bun', '--outfile', file], { env: process.env, timeout: 20000, windowsHide: true });
    fs.chmodSync(file, 0o444); fs.chmodSync(directory, 0o555);
    try {
      const { stdout } = await exec('bun', [file], { cwd: directory, env: process.env, timeout: 20000, windowsHide: true }); expect(stdout).toContain('Discord verified identities'); expect(stdout).toContain('Discord private download, bounded replies and selected document upload pass'); expect(stdout).toContain('Discord Gateway Identify, durable cursor, failed-write replay and Resume pass');
    } finally { fs.chmodSync(directory, 0o755); fs.chmodSync(file, 0o644); }
  });

  it.each(['bun', process.execPath])('receives Slack socket events after durable checks under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-slack-smoke.ts'], { env: process.env, timeout: 20000, windowsHide: true });
    expect(stdout).toContain('Slack Socket Mode, sender scope, commit-before-ack, replay and private file descriptors pass');
  });

  it('bundles the Slack intake proof without requiring a repo checkout at runtime', async () => {
    const directory = dataPath('slack-sdk-bundle'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'proof.mjs');
    await exec('bun', ['build', 'scripts/gateways-slack-smoke.ts', '--target=bun', '--outfile', file], { env: process.env, timeout: 20000, windowsHide: true });
    fs.chmodSync(file, 0o444); fs.chmodSync(directory, 0o555);
    try {
      const { stdout } = await exec('bun', [file], { cwd: directory, env: process.env, timeout: 20000, windowsHide: true });
      expect(stdout).toContain('Slack Socket Mode');
    } finally { fs.chmodSync(directory, 0o755); fs.chmodSync(file, 0o644); }
  });

  it.each(['bun', process.execPath])('receives and replies with a private file under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-smoke.ts'], { env: process.env, timeout: 20000, windowsHide: true });
    expect(stdout).toContain('Telegram polling, sender filter, private download, file reply and persistent subscription pass');
    expect(stdout).toContain('explicit paused Telegram switch keeps pending updates and private receipts across restart without polling or sends');
  });

  it('bundles the SDK and state adapter and runs from read-only application files outside the repo', async () => {
    const directory = dataPath('sdk-bundle');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'proof.mjs');
    await exec('bun', ['build', 'scripts/gateways-smoke.ts', '--target=bun', '--outfile', file], { env: process.env, timeout: 20000, windowsHide: true });
    fs.chmodSync(file, 0o444);
    fs.chmodSync(directory, 0o555);
    try {
      const { stdout } = await exec('bun', [file], { cwd: directory, env: process.env, timeout: 20000, windowsHide: true });
      expect(stdout).toContain('persistent subscription pass');
      expect(stdout).toContain('explicit paused Telegram switch keeps pending updates and private receipts across restart without polling or sends');
    } finally {
      fs.chmodSync(directory, 0o755);
      fs.chmodSync(file, 0o644);
    }
  });
});
