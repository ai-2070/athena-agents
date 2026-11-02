// The dashboard owns this private process through stdin, including after a parent crash.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
process.stdin.resume();
await import('./server/index.mjs');
