// Reading and writing PNG pictures, for the masks sent to ComfyUI: every colour type and bit depth image editors
// save, but not interlaced files (rare, and refused with a clear message).
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** A decoded picture: each pixel's grey level and alpha (0-255), row by row. */
export interface PngPixels {
  width: number;
  height: number;
  grey: Uint8Array;
  alpha: Uint8Array;
  /** Whether the file can hold transparency (an alpha channel, or a tRNS chunk). */
  hasAlpha: boolean;
}

export const isPng = (bytes: Uint8Array): boolean => bytes.length > 8 && SIGNATURE.equals(bytes.subarray(0, 8));

/** Width and height from a PNG's header, or null for anything else. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Grey as Pillow's convert("L") makes it, so a mask reads the same here as in the skill's script.
const luma = (r: number, g: number, b: number): number => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;

export function decodePng(bytes: Buffer): PngPixels {
  if (!isPng(bytes)) throw new Error('not a PNG file');
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= bytes.length;) {
    const len = bytes.readUInt32BE(pos);
    const kind = bytes.toString('latin1', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (data.length < len) throw new Error('the file is cut short');
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = CHANNELS[type];
  if (!channels || !width || !height || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && !palette))
    throw new Error('a kind of PNG this can’t read');
  if (interlace) throw new Error('an interlaced PNG: save it again without interlacing');
  if (width * height > 100_000_000) throw new Error('too big a picture');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bits = channels * depth;
  const stride = Math.ceil((width * bits) / 8);
  const bpp = Math.max(1, bits >> 3);
  if (raw.length < height * (stride + 1)) throw new Error('the picture data is cut short');

  const grey = new Uint8Array(width * height);
  const alpha = new Uint8Array(width * height).fill(255);
  const max = 2 ** depth - 1;
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  // a sample matching tRNS's one colour is fully transparent (grey and RGB pictures)
  const clear =
    trns && type === 0 && trns.length >= 2
      ? [trns.readUInt16BE(0)]
      : trns && type === 2 && trns.length >= 6
        ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
        : null;
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    for (let i = 0; i < stride; i++) {
      const x = raw[at + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('a damaged PNG (unknown row filter)');
      cur[i] = v & 255;
    }
    const sample = (k: number): number => {
      if (depth === 8) return cur[k];
      if (depth === 16) return (cur[2 * k] << 8) | cur[2 * k + 1];
      const bit = k * depth;
      return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
    };
    for (let x = 0; x < width; x++) {
      const o = y * width + x;
      if (type === 3) {
        const i = sample(x);
        grey[o] = luma(palette![3 * i] ?? 0, palette![3 * i + 1] ?? 0, palette![3 * i + 2] ?? 0);
        if (trns && i < trns.length) alpha[o] = trns[i];
      } else if (type === 0 || type === 4) {
        const v = sample(x * channels);
        grey[o] = to8(v);
        if (type === 4) alpha[o] = to8(sample(x * 2 + 1));
        else if (clear && v === clear[0]) alpha[o] = 0;
      } else {
        const r = sample(x * channels);
        const g = sample(x * channels + 1);
        const b = sample(x * channels + 2);
        grey[o] = luma(to8(r), to8(g), to8(b));
        if (type === 6) alpha[o] = to8(sample(x * 4 + 3));
        else if (clear && r === clear[0] && g === clear[1] && b === clear[2]) alpha[o] = 0;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, grey, alpha, hasAlpha: type === 4 || type === 6 || !!trns };
}

let crcTable: Uint32Array | null = null;
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A black RGBA PNG with this alpha for each pixel. */
export function encodeAlphaPng(width: number, height: number, alpha: Uint8Array): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height); // every row filter 0, colour black
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw[y * stride + 1 + x * 4 + 3] = alpha[y * width + x];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
