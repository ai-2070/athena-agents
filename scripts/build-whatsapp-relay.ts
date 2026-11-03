import path from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--outfile')) throw new Error('Use --outfile <file> or no arguments.');
const outfile = path.resolve(args[1] ?? 'relay/whatsapp/dist/worker.mjs');
const result = await Bun.build({ entrypoints: [path.resolve(import.meta.dirname, '../relay/whatsapp/worker.ts')], target: 'browser', format: 'esm', outdir: path.dirname(outfile), naming: path.basename(outfile) });
if (!result.success) throw new Error('The WhatsApp relay could not be built.');
console.log('relay: WhatsApp Worker bundled');
