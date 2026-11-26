// The dashboard owns this private process through stdin, including after a parent crash.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
process.stdin.resume();
// Since Eve 1.0.0-rc.3, nitro's own SIGTERM/SIGINT handler closes the server but never exits, so the
// process lingers. Stop at once instead, as before: the local store is built to survive being killed.
// Registered before the server loads, so this runs first.
for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
]) {
  process.on(signal, () => process.exit(code));
}
// Eve up to 1.4.0 chose spec 9 Workflow runs; since 1.5.0 the store declares it, and the local store
// (runtime/eve-world) only makes spec 9 runs when asked. Its steering, retries and restores rely on them.
process.env.WORKFLOW_SPEC_VERSION ??= '9';
await import('./server/index.mjs');
